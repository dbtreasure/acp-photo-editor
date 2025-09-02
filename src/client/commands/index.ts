import path from 'path';
import { pathToFileURL } from 'url';
import readline from 'readline';
import { JsonRpcPeer } from '../../common/jsonrpc';
import { NdjsonLogger } from '../../common/logger';
import { PromptContent, ContentBlockResourceLink } from '../../acp/types';
import { guessMimeType } from '../../common/mime';
import { itermShowImage } from '../../common/iterm-images';

export interface CommandContext {
  peer: JsonRpcPeer;
  sessionId: string;
  cwd: string;
  args: any;
  thumbnails: Map<string, { metadata?: string; image?: string; mimeType?: string }>;
  useItermImages: boolean;
  rl: readline.Interface;
  logger: NdjsonLogger;
  isPrompting: { value: boolean };
}

export type CommandHandler = (line: string, ctx: CommandContext) => Promise<void> | void;

export interface CommandEntry {
  name: string;
  description: string;
  handler: CommandHandler;
}

export const commands = new Map<string, CommandEntry>();

function makePromptCommand(name: string, description: string): CommandEntry {
  return {
    name,
    description,
    handler: async (line: string, ctx: CommandContext) => {
      if (ctx.isPrompting.value) {
        console.log('A prompt is already in progress. Use :cancel to cancel it.');
        return;
      }
      ctx.isPrompting.value = true;
      try {
        const pRes = await ctx.peer.request('session/prompt', {
          sessionId: ctx.sessionId,
          prompt: [{ type: 'text', text: line }],
        });
        console.log(`[result] stopReason: ${pRes.stopReason}`);
      } catch (e: any) {
        console.error('[error]', e?.message || String(e));
      }
      ctx.isPrompting.value = false;
    },
  };
}

commands.set(':exit', {
  name: ':exit',
  description: 'Exit the client',
  handler: async (_line: string, ctx: CommandContext) => {
    console.log('Goodbye!');
    ctx.rl.close();
    process.exit(0);
  },
});

commands.set(':gallery', {
  name: ':gallery',
  description: 'Show thumbnail gallery',
  handler: async (_line: string, ctx: CommandContext) => {
    const { thumbnails, useItermImages, args } = ctx;
    if (thumbnails.size === 0) {
      console.log('No thumbnails loaded. Use :open to load images.');
      return;
    }
    console.log('\nThumbnail Gallery:');
    console.log('==================');
    let index = 1;
    for (const [id, thumb] of thumbnails) {
      console.log(`${index}. ${thumb.metadata || 'No metadata'}`);
      if (thumb.image && thumb.mimeType) {
        const sizeKB = Math.round((thumb.image.length * 0.75) / 1024);
        console.log(`   Thumbnail: ${thumb.mimeType} (${sizeKB}KB)`);
        if (useItermImages) {
          try {
            const name = thumb.metadata?.split(' ')[0] || `gallery_${index}.png`;
            itermShowImage(thumb.image, {
              name,
              width: args['thumb-width'] || '32',
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
  },
});

commands.set(':ping', makePromptCommand(':ping', 'Send a ping message to the agent'));

const editCmds: [string, string][] = [
  [':crop', 'Apply crop/straighten to current image'],
  [':undo', 'Undo last edit operation'],
  [':redo', 'Redo previously undone operation'],
  [':reset', 'Reset to original image'],
  [':wb', 'Adjust white balance'],
  [':exposure', 'Adjust exposure'],
  [':contrast', 'Adjust contrast'],
  [':saturation', 'Adjust saturation'],
  [':vibrance', 'Adjust vibrance'],
  [':auto', 'Auto adjustments'],
  [':hist', 'Show histogram and clipping info'],
  [':yes', 'Send confirmation yes'],
  [':no', 'Send confirmation no'],
];

for (const [name, desc] of editCmds) {
  commands.set(name, makePromptCommand(name, desc));
}

commands.set(':ask', {
  name: ':ask',
  description: 'Natural language editing',
  handler: async (line: string, ctx: CommandContext) => {
    if (ctx.isPrompting.value) {
      console.log('A prompt is already in progress. Use :cancel to cancel it.');
      return;
    }
    let askText = line.substring(5).trim();
    let withImage = false;
    if (askText.startsWith('--with-image ')) {
      withImage = true;
      askText = askText.substring(13).trim();
    }
    if (
      (askText.startsWith('"') && askText.endsWith('"')) ||
      (askText.startsWith("'") && askText.endsWith("'"))
    ) {
      askText = askText.slice(1, -1);
    }
    if (!askText) {
      console.log('Usage: :ask [--with-image] <text>. Example: :ask --with-image "fix white balance"');
      return;
    }
    ctx.isPrompting.value = true;
    ctx.rl.pause();
    console.log(`Processing: ${askText}${withImage ? ' (with image)' : ''}`);
    try {
      const commandText = withImage ? `:ask --with-image ${askText}` : `:ask ${askText}`;
      const pRes = await ctx.peer.request('session/prompt', {
        sessionId: ctx.sessionId,
        prompt: [{ type: 'text', text: commandText }],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.log(`[result] stopReason: ${pRes.stopReason}`);
      ctx.rl.resume();
    } catch (e: any) {
      console.error('[error]', e?.message || String(e));
      ctx.rl.resume();
    }
    ctx.isPrompting.value = false;
  },
});

commands.set(':export', {
  name: ':export',
  description: 'Export edited image to disk',
  handler: async (line: string, ctx: CommandContext) => {
    if (ctx.isPrompting.value) {
      console.log('A prompt is already in progress. Use :cancel to cancel it.');
      return;
    }
    ctx.isPrompting.value = true;
    console.log('Preparing export...');

    ctx.peer.on('session/request_permission', (msg: any) => {
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
        if (requestId !== undefined) {
          const response = {
            jsonrpc: '2.0',
            id: requestId,
            result: { approved: true },
          };
          ctx.peer.send(response);
        }
      }
    });

    try {
      const pRes = await ctx.peer.request('session/prompt', {
        sessionId: ctx.sessionId,
        prompt: [{ type: 'text', text: line }],
        cwd: ctx.cwd,
      });
      console.log(`[result] stopReason: ${pRes.stopReason}`);
    } catch (e: any) {
      console.error('[error]', e?.message || String(e));
    }
    ctx.isPrompting.value = false;
  },
});

commands.set(':open', {
  name: ':open',
  description: 'Open image file(s)',
  handler: async (line: string, ctx: CommandContext) => {
    if (ctx.isPrompting.value) {
      console.log('A prompt is already in progress. Use :cancel to cancel it.');
      return;
    }
    const parts = line.substring(6).trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === '') {
      console.log('Usage: :open <path1> [path2...]');
      return;
    }
    ctx.isPrompting.value = true;
    ctx.thumbnails.clear();
    console.log('Opening resources...');

    const prompt: PromptContent[] = [{ type: 'text', text: 'open assets' }];
    const resources: ContentBlockResourceLink[] = parts.map((p) => {
      const absPath = path.resolve(p);
      const basename = path.basename(absPath);
      const uri = pathToFileURL(absPath).href;
      const mimeType = guessMimeType(basename);
      return {
        type: 'resource_link',
        uri,
        name: basename,
        ...(mimeType && { mimeType }),
      } as ContentBlockResourceLink;
    });
    prompt.push(...resources);

    console.log('\nResources:');
    console.log('Name\t\tURI\t\t\t\tMIME\t\tStatus');
    console.log('----\t\t---\t\t\t\t----\t\t------');
    resources.forEach((r) => {
      const shortUri = r.uri.length > 30 ? '...' + r.uri.slice(-27) : r.uri;
      console.log(`${r.name}\t${shortUri}\t${r.mimeType || 'unknown'}\tSENDING`);
    });

    ctx.logger.line('info', {
      prompt_summary: `${resources.length} resources: ${resources.map((r) => r.name).join(', ')}`,
    });

    try {
      const pRes = await ctx.peer.request('session/prompt', {
        sessionId: ctx.sessionId,
        prompt,
      });
      console.log(`\n[result] stopReason: ${pRes.stopReason}`);

      console.log('\nResources (updated):');
      console.log('Name\t\tURI\t\t\t\tMIME\t\tStatus');
      console.log('----\t\t---\t\t\t\t----\t\t------');
      resources.forEach((r) => {
        const shortUri = r.uri.length > 30 ? '...' + r.uri.slice(-27) : r.uri;
        console.log(`${r.name}\t${shortUri}\t${r.mimeType || 'unknown'}\tPROCESSED`);
      });

      if (ctx.thumbnails.size > 0) {
        console.log(`\n${ctx.thumbnails.size} thumbnail(s) loaded. Use :gallery to view.`);
      }
    } catch (e: any) {
      console.error('[error]', e?.message || String(e));
    }
    ctx.isPrompting.value = false;
  },
});

commands.set(':cancel', {
  name: ':cancel',
  description: 'Cancel the current prompt',
  handler: async (_line: string, ctx: CommandContext) => {
    if (!ctx.isPrompting.value) {
      console.log('No prompt in progress to cancel.');
    } else {
      console.log('Sending cancel...');
      ctx.peer.notify('session/cancel', { sessionId: ctx.sessionId });
    }
  },
});

export default commands;

