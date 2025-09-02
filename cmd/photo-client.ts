#!/usr/bin/env node
// Load environment variables from .env file
try {
  require('dotenv').config();
} catch (e) {
  // dotenv is optional, ignore if not available
}

import minimist from 'minimist';
import path from 'path';
import readline from 'readline';
import { pathToFileURL } from 'url';
import { NdjsonLogger } from '../src/common/logger';
import { guessMimeType } from '../src/common/mime';
import { PromptContent, ContentBlockResourceLink, MCPServerConfig } from '../src/acp/types';
import { isITerm2, itermShowImage } from '../src/common/iterm-images';
import { spawnAgentClient } from '../src/client/agentClient';
import { createSessionState } from '../src/client/sessionState';

const args = minimist(process.argv.slice(2), {
  string: [
    'agent',
    'agentArgs',
    'cwd',
    'demo',
    'tty-images',
    'planner',
    'gemini-api-key',
    'planner-timeout',
    'planner-max-calls',
    'thumb-width',
    'thumb-height',
  ],
  boolean: ['help', 'interactive', 'mcp', 'planner-log-text'],
  default: {
    interactive: true,
    mcp: false,
    'tty-images': 'auto', // auto, iterm, none
    'planner': 'mock', // mock or gemini
    'planner-timeout': '10000',
    'planner-max-calls': '6',
    'planner-log-text': false,
  },
});

const logger = new NdjsonLogger('client');

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

  const { peer } = spawnAgentClient({ agentCmd, agentArgs, logger });

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

  // Configure planner settings
  const plannerConfig: Record<string, any> = {
    type: args.planner || 'mock',
  };

  // Add Gemini-specific settings if using Gemini planner
  if (plannerConfig.type === 'gemini') {
    plannerConfig.apiKey = args['gemini-api-key'] || process.env.GEMINI_API_KEY;
    plannerConfig.timeoutMs = parseInt(args['planner-timeout'] || '10000');
    plannerConfig.maxCalls = parseInt(args['planner-max-calls'] || '6');
    plannerConfig.logText = args['planner-log-text'] === true;
  }

  // Phase 7d: Support demo mode
  const demoMode = args.demo || process.env.ACP_DEMO_MODE;
  let demoImages: string[] = [];
  if (demoMode) {
    // Parse demo mode argument (can be a number or path to image)
    const demoArg = String(demoMode);
    const demoCount = parseInt(demoArg);
    
    if (!isNaN(demoCount) && demoCount > 0) {
      // Generate N demo image paths
      const demoDir = path.join(cwd, 'test', 'fixtures');
      for (let i = 1; i <= Math.min(demoCount, 10); i++) {
        const imagePath = path.join(demoDir, `demo${i}.jpg`);
        demoImages.push(pathToFileURL(imagePath).href);
      }
    } else if (demoArg.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
      // Use specific image file
      const imagePath = path.resolve(cwd, demoArg);
      demoImages.push(pathToFileURL(imagePath).href);
    }
    
    if (demoImages.length > 0) {
      console.log(`Demo mode: Using ${demoImages.length} test image(s)`);
    }
  }

  // Initialize
  const initRes = await peer.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: {
      name: 'photo-client',
      version: '0.1.0',
    },
  });

  logger.line('info', { initialize_result: initRes });

  if (initRes.protocolVersion !== 1) {
    console.error(`Version mismatch: agent returned ${initRes.protocolVersion}, expected 1`);
    process.exit(3);
  }

  // Create session with MCP servers
  const sessionRes = await peer.request('session/new', {
    cwd: pathToFileURL(cwd).href,
    resourceLinks: [] as ContentBlockResourceLink[],
    mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
    plannerConfig: plannerConfig.type ? plannerConfig : undefined,
    demoImages: demoImages.length > 0 ? demoImages : undefined,
  });

  const sessionId = sessionRes.sessionId;
  console.log(`Session created: ${sessionId}`);
  if (mcpServers.length > 0) {
    console.log(`MCP servers configured: ${mcpServers.map((s) => s.name).join(', ')}`);
  }
  if (useItermImages) {
    console.log(`iTerm2 inline images: enabled${ttyImages === 'auto' ? ' (auto-detected)' : ''}`);
  }

  // Store readline interface reference and flag for message tracking
  let rlInterface: readline.Interface | null = null;
  let hasReceivedAgentMessage = false;

  // Create session state handler with callback for agent messages
  const sessionState = createSessionState(peer, {
    logger,
    useItermImages,
    thumbWidth: args['thumb-width'],
    thumbHeight: args['thumb-height'],
    onAgentMessage: () => {
      hasReceivedAgentMessage = true;
    }
  });
  const thumbnails = sessionState.thumbnails;

  // Interactive mode with REPL
  if (args.interactive) {
    console.log('\nPhoto Editor ACP Client - Interactive Mode');
    console.log('Commands:');
    console.log('  :ping            - Send a ping message to the agent');
    console.log('  :open <path...>  - Open image file(s)');
    console.log('  :wb [options]    - Adjust white balance');
    console.log('  :exposure <ev>   - Adjust exposure (EV stops)');
    console.log('  :contrast <amt>  - Adjust contrast');
    console.log('  :saturation <amt> - Adjust saturation');
    console.log('  :vibrance <amt>  - Adjust vibrance (smart saturation)');
    console.log('  :crop <aspect>   - Crop image (1:1, 3:2, 4:3, 16:9, or WxH)');
    console.log('  :rotate <angle>  - Rotate image by angle in degrees');
    console.log('  :auto [wb|exposure|contrast|all] - Auto-adjust settings');
    console.log('  :render          - Render current edits');
    console.log('  :renderall       - Render all loaded images');
    console.log('  :ask <text>      - Use AI planner to interpret editing request');
    console.log('  :export <path>   - Export edited image');
    console.log('  :undo            - Undo last operation');
    console.log('  :redo            - Redo undone operation');
    console.log('  :reset           - Reset all edits');
    console.log('  :stack           - Show current edit stack');
    console.log('  :status          - Show agent status');
    console.log('  :gallery         - Show loaded images (requires iTerm2)');
    console.log('  :yes             - Confirm pending operation (Phase 7f)');
    console.log('  :no              - Cancel pending operation (Phase 7f)');
    console.log('  :cancel          - Cancel current operation');
    console.log('  :help            - Show this help message');
    console.log('  :quit            - Exit the program');
    console.log('');
    console.log('White balance options:');
    console.log('  :wb temp <value>   - Adjust temperature (-100 to 100)');
    console.log('  :wb tint <value>   - Adjust tint (-100 to 100)');
    console.log('  :wb gray <x> <y>   - Set gray point (0-1 normalized)');
    console.log('  :wb auto           - Auto white balance');
    console.log('');
    console.log('Planner settings:');
    console.log('  --planner=<type>            - Planner type: mock or gemini (default: mock)');
    console.log('  --gemini-api-key=<key>      - Gemini API key (or GEMINI_API_KEY env var)');
    console.log('  --planner-timeout=<ms>      - Planner timeout in ms (default: 10000)');
    console.log('  --planner-max-calls=<n>     - Max operations per request (default: 6)');
    console.log('  --planner-log-text          - Log planner text (default: false)');
    console.log('');
    console.log('Image display settings:');
    console.log('  --tty-images=<mode>         - TTY image mode: auto, iterm, none (default: auto)');
    console.log('  --thumb-width=<value>       - Set thumbnail width (default: 64)');
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

      if (cmd === ':help' || cmd === ':h') {
        console.log('Available commands:');
        console.log('  :ping     - Send a ping message');
        console.log('  :cancel   - Cancel the current prompt');
        console.log('  :status   - Show agent status');
        console.log('  :gallery  - Show image thumbnails (iTerm2 only)');
        console.log('  :yes      - Confirm pending operation');
        console.log('  :no       - Cancel pending operation');
        console.log('  :quit     - Exit');
      } else if (cmd === ':quit' || cmd === ':q' || cmd === ':exit') {
        process.exit(0);
      } else if (cmd === ':status') {
        console.log(`Session: ${sessionId}`);
        console.log(`Working directory: ${cwd}`);
        console.log(`MCP enabled: ${mcpServers.length > 0}`);
        console.log(`Planner: ${plannerConfig.type}`);
        console.log(`iTerm2 images: ${useItermImages}`);
        console.log(`Demo mode: ${demoImages.length > 0 ? `${demoImages.length} images` : 'off'}`);
      } else if (cmd === ':gallery') {
        if (!useItermImages) {
          console.log('Gallery requires iTerm2. Use --tty-images=iterm to enable.');
        } else if (thumbnails.size === 0) {
          console.log('No images loaded yet. Use :open to load images.');
        } else {
          console.log(`Gallery: ${thumbnails.size} image(s)`);
          for (const [id, thumb] of thumbnails) {
            if (thumb.image) {
              const name = thumb.metadata?.split(' ')[0] || `${id}.png`;
              try {
                itermShowImage(thumb.image, {
                  name,
                  width: '32',
                  height: 'auto',
                  preserveAspectRatio: true,
                });
                console.log(`  - ${name}`);
              } catch (err: any) {
                console.log(`  - ${name} (display failed: ${err.message})`);
              }
            }
          }
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
      } else if (cmd.startsWith(':open')) {
        // Extract file paths
        const pathArgs = cmd.substring(5).trim();
        if (!pathArgs) {
          console.log('Usage: :open <path...>. Example: :open image1.jpg image2.png');
        } else {
          // Handle quoted paths and multiple files
          const paths = pathArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
          const resources: ContentBlockResourceLink[] = paths.map((p) => {
            // Remove quotes if present
            const cleanPath = p.replace(/^"|"$/g, '');
            const fullPath = path.resolve(cwd, cleanPath);
            const mimeType = guessMimeType(fullPath);
            return {
              type: 'resource_link',
              name: path.basename(fullPath),
              uri: pathToFileURL(fullPath).href,
              mimeType,
            };
          });

          if (resources.length === 0) {
            console.log('No valid paths provided');
          } else {
            isPrompting = true;
            console.log(`Opening ${resources.length} file(s)...`);
            try {
              const prompt: PromptContent[] = [
                { type: 'text', text: `:open ${resources.map((r) => r.name).join(' ')}` },
              ];
              resources.forEach((r) => prompt.push(r));

              const pRes = await peer.request('session/prompt', {
                sessionId,
                prompt,
              });
              console.log(`[result] stopReason: ${pRes.stopReason}`);
            } catch (e: any) {
              console.error('[error]', e?.message || String(e));
            }
            isPrompting = false;
          }
        }
      } else if (cmd.startsWith(':ask')) {
        // Parse the :ask command
        let askText = cmd.substring(4).trim();
        const withImage = askText.includes('--with-image');
        const forceConfirm = askText.includes('--confirm');
        const autoConfirm = askText.includes('--auto-confirm');
        
        // Remove flags from text
        askText = askText
          .replace('--with-image', '')
          .replace('--confirm', '')
          .replace('--auto-confirm', '')
          .trim();
        
        // Handle quoted text
        if (
          (askText.startsWith('"') && askText.endsWith('"')) ||
          (askText.startsWith("'") && askText.endsWith("'"))
        ) {
          askText = askText.slice(1, -1);
        }
        if (!askText) {
          console.log('Usage: :ask [--with-image] [--confirm] [--auto-confirm] <text>');
          console.log('  --with-image: Include current image for vision analysis');
          console.log('  --confirm: Always ask for confirmation before applying');
          console.log('  --auto-confirm: Auto-apply if confidence >= 80%');
        } else {
          isPrompting = true;
          // Pause readline to prevent interference
          rl.pause();
          console.log(`Processing: ${askText}${withImage ? ' (with image)' : ''}${forceConfirm ? ' (confirm)' : ''}${autoConfirm ? ' (auto-confirm)' : ''}`);
          try {
            // Build command text with flags
            let commandText = ':ask';
            if (withImage) commandText += ' --with-image';
            if (forceConfirm) commandText += ' --confirm';
            if (autoConfirm) commandText += ' --auto-confirm';
            commandText += ` ${askText}`;
            
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
      } else if (cmd.startsWith(':export')) {
        // Handle export command
        if (isPrompting) {
          console.log('A prompt is already in progress. Use :cancel to cancel it.');
        } else {
          const exportArgs = cmd.substring(7).trim();
          isPrompting = true;
          console.log(`Exporting...`);
          try {
            const pRes = await peer.request('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text: `:export ${exportArgs}` }],
            });
            console.log(`[result] stopReason: ${pRes.stopReason}`);
          } catch (e: any) {
            console.error('[error]', e?.message || String(e));
          }
          isPrompting = false;
        }
      } else if (
        cmd.startsWith(':wb') ||
        cmd.startsWith(':exposure') ||
        cmd.startsWith(':contrast') ||
        cmd.startsWith(':saturation') ||
        cmd.startsWith(':vibrance') ||
        cmd.startsWith(':crop') ||
        cmd.startsWith(':rotate') ||
        cmd.startsWith(':auto') ||
        cmd.startsWith(':render') ||
        cmd === ':undo' ||
        cmd === ':redo' ||
        cmd === ':reset' ||
        cmd === ':stack'
      ) {
        // Forward editing commands to agent
        if (isPrompting) {
          console.log('A prompt is already in progress. Use :cancel to cancel it.');
        } else {
          isPrompting = true;
          console.log(`Processing: ${cmd}`);
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
            // For non-command text, check if it's a yes/no response
            const lowerCmd = cmd.toLowerCase();
            if (lowerCmd === 'yes' || lowerCmd === 'no') {
              // Convert to :yes or :no for consistency
              const pRes = await peer.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: `:${lowerCmd}` }],
              });
              console.log(`[result] stopReason: ${pRes.stopReason}`);
            } else {
              const pRes = await peer.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: cmd }],
              });
              console.log(`[result] stopReason: ${pRes.stopReason}`);
            }
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
    console.log('Ping response:', pRes);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});