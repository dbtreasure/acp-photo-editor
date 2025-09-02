import { JsonRpcPeer } from '../common/jsonrpc';
import { NdjsonLogger } from '../common/logger';
import { itermShowImage } from '../common/iterm-images';

export interface Thumbnail {
  metadata?: string;
  image?: string;
  mimeType?: string;
}

export interface SessionStateOptions {
  logger: NdjsonLogger;
  useItermImages: boolean;
  thumbWidth?: string;
  thumbHeight?: string;
  onAgentMessage?: () => void;  // Callback when agent messages are received
}

export class SessionState {
  public thumbnails: Map<string, Thumbnail> = new Map();

  constructor(peer: JsonRpcPeer, private opts: SessionStateOptions) {
    peer.on('session/update', (params: any) => this.handleUpdate(params));
  }

  private handleUpdate(params: any) {
    const { logger, useItermImages, thumbWidth, thumbHeight } = this.opts;

    if (params.sessionUpdate === 'tool_call_update') {
      const { toolCallId, status, content } = params;

      if (status === 'in_progress' && content) {
        for (const item of content) {
          if (item.type === 'content') {
            const block = item.content;
            if (block.type === 'text') {
              if (!this.thumbnails.has(toolCallId)) {
                this.thumbnails.set(toolCallId, {});
              }
              this.thumbnails.get(toolCallId)!.metadata = block.text;
              console.log(`[metadata:${toolCallId}] ${block.text}`);
            } else if (block.type === 'image') {
              if (!this.thumbnails.has(toolCallId)) {
                this.thumbnails.set(toolCallId, {});
              }
              const thumb = this.thumbnails.get(toolCallId)!;
              thumb.image = block.data;
              thumb.mimeType = block.mimeType;

              const sizeKB = Math.round((block.data.length * 0.75) / 1024);
              const preview = block.data.substring(0, 20) + '...';
              console.log(`[thumbnail:${toolCallId}] Received ${block.mimeType} (${sizeKB}KB, data="${preview}")`);

              if (useItermImages && block.data) {
                try {
                  const metadata = this.thumbnails.get(toolCallId)?.metadata;
                  const name = metadata?.split(' ')[0] || `${toolCallId}.png`;
                  itermShowImage(block.data, {
                    name,
                    width: thumbWidth || '64',
                    height: thumbHeight || 'auto',
                    preserveAspectRatio: true,
                  });
                  console.log(`[iTerm2] Displayed inline: ${name}`);
                } catch (err: any) {
                  console.log(`[iTerm2] Failed to display: ${err.message}`);
                }
              }

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
        if (content && Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'image') {
              const thumb = this.thumbnails.get(toolCallId) || {};
              thumb.image = item.data;
              thumb.mimeType = item.mimeType || 'image/png';
              this.thumbnails.set(toolCallId, thumb);

              const sizeKB = Math.round((item.data.length * 0.75) / 1024);
              console.log(`[preview:${toolCallId}] Received ${thumb.mimeType} (${sizeKB}KB)`);

              if (useItermImages) {
                try {
                  itermShowImage(item.data, {
                    name: `preview_${toolCallId}.png`,
                    width: thumbWidth || '64',
                    height: thumbHeight || 'auto',
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
    } else if (params.sessionUpdate === 'agent_message_chunk') {
      const content = params?.content?.text ?? '';
      // Split multi-line content and prefix each line
      const lines = content.split('\n');
      lines.forEach((line: string) => {
        console.log(`[agent] ${line}`);
      });
      // Notify that agent messages were received
      if (this.opts.onAgentMessage) {
        this.opts.onAgentMessage();
      }
    }
  }
}

export function createSessionState(peer: JsonRpcPeer, opts: SessionStateOptions): SessionState {
  return new SessionState(peer, opts);
}
