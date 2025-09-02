#!/usr/bin/env node
// Load environment variables from .env file
try {
  require('dotenv').config();
} catch (e) {
  // dotenv is optional, ignore if not available
}

import minimist from 'minimist';
import { spawn } from 'child_process';
import path from 'path';
import readline from 'readline';
import { JsonRpcPeer } from '../src/common/jsonrpc';
import { NdjsonLogger } from '../src/common/logger';
import { MCPServerConfig } from '../src/acp/types';
import { isITerm2, itermShowImage } from '../src/common/iterm-images';
import commands, { CommandContext } from '../src/client/commands';

const args = minimist(process.argv.slice(2), {
  string: [
    'agent',
    'agentArgs',
    'cwd',
    'demo',
    'tty-images',
    'thumb-width',
    'thumb-height',
    'planner',
    'planner-model',
    'planner-timeout',
    'planner-max-calls',
  ],
  boolean: ['interactive', 'mcp', 'planner-log-text'],
  alias: { i: 'interactive' },
  default: {
    mcp: true, // Enable MCP by default
    'tty-images': 'auto', // Auto-detect iTerm2
    planner: 'mock', // Default to mock planner
    'planner-model': 'gemini-2.5-flash',
    'planner-timeout': '10000',
    'planner-max-calls': '6',
    'planner-log-text': false,
  },
});

const logger = new NdjsonLogger('client');

// Track thumbnails for display
const thumbnails: Map<string, { metadata?: string; image?: string; mimeType?: string }> = new Map();

async function main() {
  const agentCmd = args.agent || process.env.ACP_AGENT || '';
  const agentArgs = args.agentArgs ? String(args.agentArgs).split(' ') : [];
  const cwd = path.resolve(args.cwd || process.cwd());

  // Determine TTY image rendering mode
  const ttyImages = args['tty-images'];
  const useItermImages = ttyImages === 'iterm' || (ttyImages === 'auto' && isITerm2());

  if (!agentCmd) {
    console.error('photo-client: --agent <cmd> is required');
    process.exit(2);
  }

  // Spawn agent
  const child = spawn(agentCmd, agentArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  const peer = new JsonRpcPeer(child.stdout, child.stdin, logger);

  // Configure MCP servers if enabled
  const mcpServers: MCPServerConfig[] = args.mcp
    ? [
        {
          name: 'image',
          command: 'node',
          args: [path.join(__dirname, 'mcp-image-server.js')],
          env: {},
        },
      ]
    : [];

  // Demo mode: run handshake and ping
  if (args.demo === 'ping') {
    try {
      const initRes = await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      console.log('DEMO:INIT:OK', JSON.stringify(initRes));

      const newRes = await peer.request('session/new', {
        cwd,
        mcpServers,
        planner: args.planner,
        plannerModel: args['planner-model'],
        plannerTimeout: parseInt(args['planner-timeout']),
        plannerMaxCalls: parseInt(args['planner-max-calls']),
        plannerLogText: args['planner-log-text'],
      });
      const sessionId = newRes.sessionId;
      console.log('DEMO:SESSION', sessionId);

      peer.on('session/update', (params: any) => {
        const content = params?.content?.text ?? '';
        console.log('DEMO:CHUNK', content);
      });

      const pRes = await peer.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'ping' }],
      });
      console.log('DEMO:STOP', pRes.stopReason);
      process.exit(pRes.stopReason === 'end_turn' ? 0 : 3);
    } catch (err: any) {
      console.error('DEMO:ERROR', err?.message || String(err));
      process.exit(1);
    }
    return;
  }

  // Initialize protocol
  try {
    const initRes = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    console.log('Connected to agent');
    console.log(`Protocol version: ${initRes.protocolVersion}`);
    console.log(`Agent capabilities:`, JSON.stringify(initRes.agentCapabilities, null, 2));

    // Check for version mismatch
    if (initRes.protocolVersion !== 1) {
      console.error(
        `ERROR: Protocol version mismatch. Client supports version 1, agent returned version ${initRes.protocolVersion}`
      );
      process.exit(1);
    }

    const newRes = await peer.request('session/new', { cwd, mcpServers, planner: args.planner });
    const sessionId = newRes.sessionId;
    console.log(`Session created: ${sessionId}`);
    if (mcpServers.length > 0) {
      console.log(`MCP servers configured: ${mcpServers.map((s) => s.name).join(', ')}`);
    }
    if (useItermImages) {
      console.log(`iTerm2 inline images: enabled${ttyImages === 'auto' ? ' (auto-detected)' : ''}`);
    }

    // Store readline interface reference for pausing/resuming
    let rlInterface: readline.Interface | null = null;
    let hasReceivedAgentMessage = false;
    
    // Set up session update handler
    peer.on('session/update', (params: any) => {
      // Handle tool_call_update
      if (params.sessionUpdate === 'tool_call_update') {
        const { toolCallId, status, content } = params;

        if (status === 'in_progress' && content) {
          for (const item of content) {
            if (item.type === 'content') {
              const block = item.content;
              if (block.type === 'text') {
                // Store metadata
                if (!thumbnails.has(toolCallId)) {
                  thumbnails.set(toolCallId, {});
                }
                thumbnails.get(toolCallId)!.metadata = block.text;
                console.log(`[metadata:${toolCallId}] ${block.text}`);
              } else if (block.type === 'image') {
                // Store image data
                if (!thumbnails.has(toolCallId)) {
                  thumbnails.set(toolCallId, {});
                }
                const thumb = thumbnails.get(toolCallId)!;
                thumb.image = block.data;
                thumb.mimeType = block.mimeType;

                // Display thumbnail info (truncate base64 in logs)
                const sizeKB = Math.round((block.data.length * 0.75) / 1024); // Estimate from base64
                const preview = block.data.substring(0, 20) + '...';
                console.log(`[thumbnail:${toolCallId}] Received ${block.mimeType} (${sizeKB}KB, data="${preview}")`);

                // Display inline image in iTerm2 if enabled
                if (useItermImages && block.data) {
                  try {
                    // Extract name from metadata or use toolCallId
                    const metadata = thumbnails.get(toolCallId)?.metadata;
                    const name = metadata?.split(' ')[0] || `${toolCallId}.png`;

                    itermShowImage(block.data, {
                      name,
                      width: args['thumb-width'] || '64', // Default to 64 cells
                      height: args['thumb-height'] || 'auto',
                      preserveAspectRatio: true,
                    });

                    console.log(`[iTerm2] Displayed inline: ${name}`);
                  } catch (err: any) {
                    console.log(`[iTerm2] Failed to display: ${err.message}`);
                  }
                }

                // Log truncated version for NDJSON
                logger.line('info', {
                  tool_call_thumbnail: toolCallId,
                  mimeType: block.mimeType,
                  sizeKB,
                  dataPreview: preview,
                  itermRendered: useItermImages,
                });
              }
            }
          }
        } else if (status === 'completed') {
          // Check if we have image content in the completed update
          if (content && Array.isArray(content)) {
            for (const item of content) {
              if (item.type === 'image') {
                const thumb = thumbnails.get(toolCallId) || {};
                thumb.image = item.data;
                thumb.mimeType = item.mimeType || 'image/png';
                thumbnails.set(toolCallId, thumb);

                const sizeKB = Math.round((item.data.length * 0.75) / 1024);
                console.log(`[preview:${toolCallId}] Received ${thumb.mimeType} (${sizeKB}KB)`);

                // Display image in iTerm2 if supported
                if (useItermImages) {
                  try {
                    itermShowImage(item.data, {
                      name: `preview_${toolCallId}.png`,
                      width: args['thumb-width'] || '64',
                      height: args['thumb-height'] || 'auto',
                      preserveAspectRatio: true,
                    });
                    console.log(`[iTerm2] Displayed preview`);
                  } catch (err: any) {
                    console.log(`[iTerm2] Failed to display: ${err.message}`);
                  }
                }
              }
            }
          }
          console.log(`[completed:${toolCallId}]`);
        } else if (status === 'failed') {
          console.log(`[failed:${toolCallId}]`);
        }
      }
      // Handle regular message chunks
      else if (params.sessionUpdate === 'agent_message_chunk') {
        const content = params?.content?.text ?? '';
        hasReceivedAgentMessage = true;
        // Split multi-line content and prefix each line
        const lines = content.split('\n');
        lines.forEach((line: string) => {
          console.log(`[agent] ${line}`);
        });
      }
    });

    // Interactive mode with REPL
    if (args.interactive) {
      console.log('\nPhoto Editor ACP Client - Interactive Mode');
      console.log('Commands:');
      for (const { name, description } of commands.values()) {
        console.log(`  ${name.padEnd(15)} - ${description}`);
      }
      console.log('');
      console.log('Options:');
      console.log('  --tty-images=auto|iterm|off - Control inline image display (default: auto)');
      console.log('  --thumb-width=<value>       - Set thumbnail width (default: 64 cells)');
      console.log('  --thumb-height=<value>      - Set thumbnail height (default: auto)');
      console.log('');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> ',
      });

      // Store reference for use in session/update handler
      rlInterface = rl;

      const isPrompting = { value: false };

      rl.prompt();

      rl.on('line', async (line) => {
        const cmd = line.trim();
        const [name] = cmd.split(/\s+/);
        const ctx: CommandContext = {
          peer,
          sessionId,
          cwd,
          args,
          thumbnails,
          useItermImages,
          rl,
          logger,
          isPrompting,
        };
        const entry = commands.get(name);

        if (entry) {
          await entry.handler(cmd, ctx);
        } else if (name.startsWith(':')) {
          console.log(`Unknown command: ${name}`);
        } else if (cmd.length > 0) {
          if (isPrompting.value) {
            console.log('A prompt is already in progress. Use :cancel to cancel it.');
          } else {
            isPrompting.value = true;
            console.log(`Sending: ${cmd}`);
            try {
              const pRes = await peer.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: cmd }],
              });
              console.log(`[result] stopReason: ${pRes.stopReason}`);
            } catch (e: any) {
              console.error('[error]', e?.message || String(e));
            }
            isPrompting.value = false;
          }
        }

        if (hasReceivedAgentMessage) {
          hasReceivedAgentMessage = false;
          setTimeout(() => rl.prompt(), 100);
        } else {
          rl.prompt();
        }
      });

      rl.on('close', () => {
        process.exit(0);
      });
    } else {
      // Default non-interactive mode: just send ping and exit
      const pRes = await peer.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'ping' }],
      });
      console.log(`[result] stopReason=${pRes.stopReason}`);
      process.exit(0);
    }
  } catch (e: any) {
    console.error('ERR', e?.message || String(e));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
