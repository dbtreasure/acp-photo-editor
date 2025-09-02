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
import { pathToFileURL } from 'url';
import { JsonRpcPeer } from '../src/common/jsonrpc';
import { NdjsonLogger } from '../src/common/logger';
import { guessMimeType } from '../src/common/mime';
import { PromptContent, ContentBlockResourceLink, MCPServerConfig } from '../src/acp/types';
import { isITerm2, itermShowImage } from '../src/common/iterm-images';

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
      console.log('  :ping            - Send a ping message to the agent');
      console.log('  :open <path...>  - Open image file(s)');
      console.log('  :wb [options]    - Adjust white balance');
      console.log('    --gray x,y     - Set gray point (0-1 normalized)');
      console.log('    --temp n       - Temperature adjustment (-100 to 100)');
      console.log('    --tint n       - Tint adjustment (-100 to 100)');
      console.log("    --new-op       - Force new operation (don't amend last)");
      console.log('  :exposure        - Adjust exposure');
      console.log('    --ev n         - Exposure value (-3 to 3 stops)');
      console.log("    --new-op       - Force new operation (don't amend last)");
      console.log('  :contrast        - Adjust contrast');
      console.log('    --amt n        - Contrast amount (-100 to 100)');
      console.log("    --new-op       - Force new operation (don't amend last)");
      console.log('  :saturation      - Adjust saturation');
      console.log('    --amt n        - Saturation amount (-100 to 100)');
      console.log("    --new-op       - Force new operation (don't amend last)");
      console.log('  :vibrance        - Adjust vibrance (soft saturation)');
      console.log('    --amt n        - Vibrance amount (-100 to 100)');
      console.log("    --new-op       - Force new operation (don't amend last)");
      console.log('  :auto <type>     - Auto adjustments');
      console.log('    wb             - Auto white balance');
      console.log('    ev             - Auto exposure');
      console.log('    contrast       - Auto contrast');
      console.log('    all            - Apply all auto adjustments');
      console.log('  :hist            - Show histogram and clipping info');
      console.log('  :crop [options]  - Apply crop/straighten to current image');
      console.log('    --aspect 1:1   - Crop to aspect ratio (1:1, 16:9, 3:2, etc)');
      console.log('    --rect x,y,w,h - Crop to normalized rectangle [0-1]');
      console.log('    --angle deg    - Rotate/straighten by degrees');
      console.log("    --new-op       - Force new operation (don't amend last)");
      console.log('  :undo            - Undo last edit operation');
      console.log('  :redo            - Redo previously undone operation');
      console.log('  :reset           - Reset to original image');
      console.log('  :ask [--with-image] <text> - Natural language editing (Phase 7a/7c)');
      console.log('    --with-image     - Include preview image for visual analysis (WB only)');
      console.log('    Examples: :ask warmer, +0.5 ev, more contrast, crop square');
      console.log('              :ask cool by 15, contrast -10, 16:9, straighten 1.2°');
      console.log('              :ask --with-image "fix white balance"');
      console.log('  :export [opts]   - Export edited image to disk');
      console.log('    --format jpeg|png    - Output format (default: jpeg)');
      console.log('    --quality 1-100      - JPEG quality (default: 90)');
      console.log('    --dst <path>         - Destination path (default: ./Export/)');
      console.log('    --overwrite          - Overwrite existing files');
      console.log('  :cancel          - Cancel the current prompt');
      console.log('  :gallery         - Show thumbnail gallery');
      console.log('  :exit            - Exit the client');
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

      let isPrompting = false;

      rl.prompt();

      rl.on('line', async (line) => {
        const cmd = line.trim();

        if (cmd === ':exit') {
          console.log('Goodbye!');
          rl.close();
          process.exit(0);
        } else if (cmd === ':gallery') {
          // Display thumbnail gallery
          if (thumbnails.size === 0) {
            console.log('No thumbnails loaded. Use :open to load images.');
          } else {
            console.log('\nThumbnail Gallery:');
            console.log('==================');
            let index = 1;
            for (const [id, thumb] of thumbnails) {
              console.log(`${index}. ${thumb.metadata || 'No metadata'}`);
              if (thumb.image && thumb.mimeType) {
                const sizeKB = Math.round((thumb.image.length * 0.75) / 1024);
                console.log(`   Thumbnail: ${thumb.mimeType} (${sizeKB}KB)`);

                // Display image in iTerm2 if supported
                if (useItermImages) {
                  try {
                    const name = thumb.metadata?.split(' ')[0] || `gallery_${index}.png`;
                    itermShowImage(thumb.image, {
                      name,
                      width: args['thumb-width'] || '32', // Smaller for gallery view
                      height: args['thumb-height'] || 'auto',
                      preserveAspectRatio: true,
                    });
                  } catch (err: any) {
                    console.log(`   [iTerm2] Failed to display: ${err.message}`);
                  }
                }
              }
              index++;
            }
            console.log('');
          }
        } else if (cmd === ':ping') {
          if (isPrompting) {
            console.log('A prompt is already in progress. Use :cancel to cancel it.');
          } else {
            isPrompting = true;
            console.log('Sending ping...');
            try {
              const pRes = await peer.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: 'ping' }],
              });
              console.log(`[result] stopReason: ${pRes.stopReason}`);
            } catch (e: any) {
              console.error('[error]', e?.message || String(e));
            }
            isPrompting = false;
          }
        } else if (
          cmd.startsWith(':crop') ||
          cmd === ':undo' ||
          cmd === ':redo' ||
          cmd === ':reset' ||
          cmd.startsWith(':wb') ||
          cmd.startsWith(':exposure') ||
          cmd.startsWith(':contrast') ||
          cmd.startsWith(':saturation') ||
          cmd.startsWith(':vibrance') ||
          cmd.startsWith(':auto') ||
          cmd === ':hist'
        ) {
          // Handle edit commands
          if (isPrompting) {
            console.log('A prompt is already in progress. Use :cancel to cancel it.');
          } else {
            isPrompting = true;
            console.log(`Executing ${cmd.split(' ')[0]}...`);
            try {
              const pRes = await peer.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: cmd }],
              });
              console.log(`[result] stopReason: ${pRes.stopReason}`);
            } catch (e: any) {
              console.error('[error]', e?.message || String(e));
            }
            isPrompting = false;
          }
        } else if (cmd.startsWith(':ask ')) {
          // Handle natural language ask command (Phase 7a/7c)
          if (isPrompting) {
            console.log('A prompt is already in progress. Use :cancel to cancel it.');
          } else {
            // Extract text after :ask, checking for --with-image flag
            let askText = cmd.substring(5).trim();
            let withImage = false;

            // Check for --with-image flag (Phase 7c)
            if (askText.startsWith('--with-image ')) {
              withImage = true;
              askText = askText.substring(13).trim(); // Remove flag
            }

            // Remove surrounding quotes if present
            if (
              (askText.startsWith('"') && askText.endsWith('"')) ||
              (askText.startsWith("'") && askText.endsWith("'"))
            ) {
              askText = askText.slice(1, -1);
            }
            if (!askText) {
              console.log('Usage: :ask [--with-image] <text>. Example: :ask --with-image "fix white balance"');
            } else {
              isPrompting = true;
              // Pause readline to prevent interference
              rl.pause();
              console.log(`Processing: ${askText}${withImage ? ' (with image)' : ''}`);
              try {
                // Include the --with-image flag in the command if present
                const commandText = withImage ? `:ask --with-image ${askText}` : `:ask ${askText}`;
                const pRes = await peer.request('session/prompt', {
                  sessionId,
                  prompt: [{ type: 'text', text: commandText }],
                });
                // Give time for all output to be displayed
                await new Promise(resolve => setTimeout(resolve, 100));
                console.log(`[result] stopReason: ${pRes.stopReason}`);
                // Resume readline
                rl.resume();
              } catch (e: any) {
                console.error('[error]', e?.message || String(e));
                rl.resume();
              }
              isPrompting = false;
            }
          }
        } else if (cmd.startsWith(':export')) {
          // Handle export command
          if (isPrompting) {
            console.log('A prompt is already in progress. Use :cancel to cancel it.');
          } else {
            isPrompting = true;
            console.log('Preparing export...');

            // Set up permission handler before sending the prompt
            peer.on('session/request_permission', (msg: any) => {
              // Handle both notification style (params) and request style (full object)
              const params = msg.params || msg;
              const requestId = msg.id;

              if (params && params.title) {
                const { title, explanation, operations } = params;
                console.log('\n📝 Permission Request:');
                console.log(`   Title: ${title}`);
                console.log(`   Explanation: ${explanation}`);
                if (operations) {
                  console.log('   Operations:');
                  operations.forEach((op: any) => {
                    const sizeInfo = op.bytesApprox ? ` (~${Math.round(op.bytesApprox / 1024)}KB)` : '';
                    console.log(`     - ${op.kind}: ${path.basename(op.uri)}${sizeInfo}`);
                  });
                }
                console.log('   [Auto-approving for demo]');

                // Send approval response if we have an id
                if (requestId !== undefined) {
                  const response = {
                    jsonrpc: '2.0',
                    id: requestId,
                    result: { approved: true },
                  };
                  peer.send(response);
                }
              }
            });

            try {
              const pRes = await peer.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: cmd }],
                cwd, // Pass CWD for resolving paths
              });
              console.log(`[result] stopReason: ${pRes.stopReason}`);
            } catch (e: any) {
              console.error('[error]', e?.message || String(e));
            }
            isPrompting = false;
          }
        } else if (cmd.startsWith(':open ')) {
          if (isPrompting) {
            console.log('A prompt is already in progress. Use :cancel to cancel it.');
          } else {
            const parts = cmd.substring(6).trim().split(/\s+/);
            if (parts.length === 0 || parts[0] === '') {
              console.log('Usage: :open <path1> [path2...]');
            } else {
              isPrompting = true;
              thumbnails.clear(); // Clear previous thumbnails
              console.log('Opening resources...');

              // Build prompt with text and resource_links
              const prompt: PromptContent[] = [{ type: 'text', text: 'open assets' }];

              // Convert paths to absolute file:// URIs
              const resources: ContentBlockResourceLink[] = parts.map((p) => {
                const absPath = path.resolve(p);
                const basename = path.basename(absPath);
                const uri = pathToFileURL(absPath).href;
                const mimeType = guessMimeType(basename);

                return {
                  type: 'resource_link' as const,
                  uri,
                  name: basename,
                  ...(mimeType && { mimeType }),
                };
              });

              prompt.push(...resources);

              // Display table
              console.log('\nResources:');
              console.log('Name\t\tURI\t\t\t\tMIME\t\tStatus');
              console.log('----\t\t---\t\t\t\t----\t\t------');
              resources.forEach((r) => {
                const shortUri = r.uri.length > 30 ? '...' + r.uri.slice(-27) : r.uri;
                console.log(`${r.name}\t${shortUri}\t${r.mimeType || 'unknown'}\tSENDING`);
              });

              // Log the prompt summary
              logger.line('info', {
                prompt_summary: `${resources.length} resources: ${resources.map((r) => r.name).join(', ')}`,
              });

              try {
                const pRes = await peer.request('session/prompt', {
                  sessionId,
                  prompt,
                });
                console.log(`\n[result] stopReason: ${pRes.stopReason}`);

                // Update table with PROCESSED status
                console.log('\nResources (updated):');
                console.log('Name\t\tURI\t\t\t\tMIME\t\tStatus');
                console.log('----\t\t---\t\t\t\t----\t\t------');
                resources.forEach((r) => {
                  const shortUri = r.uri.length > 30 ? '...' + r.uri.slice(-27) : r.uri;
                  console.log(`${r.name}\t${shortUri}\t${r.mimeType || 'unknown'}\tPROCESSED`);
                });

                if (thumbnails.size > 0) {
                  console.log(`\n${thumbnails.size} thumbnail(s) loaded. Use :gallery to view.`);
                }
              } catch (e: any) {
                console.error('[error]', e?.message || String(e));
              }
              isPrompting = false;
            }
          }
        } else if (cmd === ':cancel') {
          if (!isPrompting) {
            console.log('No prompt in progress to cancel.');
          } else {
            console.log('Sending cancel...');
            peer.notify('session/cancel', { sessionId });
          }
        } else if (cmd === ':yes' || cmd === ':no') {
          // Phase 7f: Handle confirmation responses
          if (isPrompting) {
            console.log('A prompt is already in progress. Use :cancel to cancel it.');
          } else {
            isPrompting = true;
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
            isPrompting = false;
          }
        } else if (cmd.startsWith(':')) {
          console.log(`Unknown command: ${cmd}`);
        } else if (cmd.length > 0) {
          // Send custom text (for future phases)
          if (isPrompting) {
            console.log('A prompt is already in progress. Use :cancel to cancel it.');
          } else {
            isPrompting = true;
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
            isPrompting = false;
          }
        }

        // Only re-prompt if we haven't received agent messages
        // If we did receive messages, delay the prompt to ensure they're visible
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
