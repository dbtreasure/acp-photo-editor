#!/usr/bin/env node
// Load environment variables from .env file
try {
  require('dotenv').config();
} catch (e) {
  // dotenv is optional, ignore if not available
}

import { createNdjsonReader } from '../src/common/ndjson';
import { NdjsonLogger } from '../src/common/logger';
import { Readable } from 'stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCPServerConfig, ContentBlock, ToolCallContent, PermissionOperation } from '../src/acp/types';
import { EditStackManager, EditStack } from '../src/editStack';
import { MockPlanner } from '../src/planner/mock';
import { GeminiPlanner, PlannerState as GeminiPlannerState } from '../src/planner/gemini';
import { Planner, PlannedCall, PLANNER_CLAMPS } from '../src/planner/types';
import { computeDeltas, areAllDeltasBelowEpsilon, formatDeltasForDisplay, ImageStats } from '../src/deltaMapper';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { 
  initTelemetry, 
  withSpan, 
  addSpanAttributes, 
  addSpanEvent,
  getTraceId,
  shutdownTelemetry 
} from '../src/telemetry/tracing';
import { SpanStatusCode } from '@opentelemetry/api';

// Initialize telemetry
initTelemetry({
  serviceName: 'photo-agent',
  debug: process.env.OTEL_DEBUG === 'true'
});

const logger = new NdjsonLogger('agent');

type Req = { id: number; method: string; params: any };
let currentSessionId: string | null = null;
let cancelled = false;
let mcpClients: Map<string, Client> = new Map();

// Phase 7f: Map to store pending plans for confirmation
const pendingPlans = new Map<string, { calls: PlannedCall[], timestamp: number }>();

// Clean up stale pending plans every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, plan] of pendingPlans.entries()) {
    if (now - plan.timestamp > 60000) { // 1 minute timeout
      pendingPlans.delete(sessionId);
    }
  }
}, 300000);

// Per-image edit state management
const imageStacks = new Map<string, EditStackManager>();
let lastLoadedImage: string | null = null;

// Turn counter for tracking
let turnCounter = 0;

// Cache image metadata to avoid repeated tool calls
const imageMetadataCache = new Map<string, { width: number; height: number; mimeType?: string }>();

// Phase 7e: Reference image management
interface ReferenceImage {
  path: string;
  stats: any; // ImageStats from MCP tool
  fileHash?: string;
  size?: number;
  mtime?: number;
}
let referenceImage: ReferenceImage | null = null;
const referenceStatsCache = new Map<string, any>(); // Cache by hash

// Planner configuration (from session/new)
let plannerMode: 'mock' | 'gemini' | 'off' = 'mock';
let plannerConfig: {
  model?: string;
  timeout?: number;
  maxCalls?: number;
  logText?: boolean;
} = {};

// Permission request tracking
const pendingPermissions = new Map<
  number,
  {
    resolve: (value: boolean) => void;
    reject: (reason?: any) => void;
    timeout: NodeJS.Timeout;
  }
>();

// Phase 7f: User input request tracking
const pendingInputRequests = new Map<
  number,
  {
    resolve: (value: string) => void;
    reject: (reason?: any) => void;
    timeout: NodeJS.Timeout;
  }
>();

// Request ID counter for notifications
let requestIdCounter = 1000;

// Read stdin as NDJSON
createNdjsonReader(process.stdin as unknown as Readable, (obj: any) => {
  logger.line('recv', obj);

  // Check if this is a response to a pending permission request
  if (obj && obj.jsonrpc === '2.0' && typeof obj.id === 'number' && pendingPermissions.has(obj.id)) {
    const pending = pendingPermissions.get(obj.id)!;
    clearTimeout(pending.timeout);
    pendingPermissions.delete(obj.id);

    // Check if permission was granted
    const approved = obj.result?.approved === true;
    pending.resolve(approved);
    return;
  }
  
  // Phase 7f: Check if this is a response to a pending input request
  if (obj && obj.jsonrpc === '2.0' && typeof obj.id === 'number' && pendingInputRequests.has(obj.id)) {
    const pending = pendingInputRequests.get(obj.id)!;
    clearTimeout(pending.timeout);
    pendingInputRequests.delete(obj.id);
    
    // Get the user input from the response
    const userInput = obj.result?.input || obj.result?.answer || '';
    pending.resolve(userInput);
    return;
  }

  if (!obj || obj.jsonrpc !== '2.0' || typeof obj.method !== 'string') return;
  const id = obj.id;
  const method = obj.method;
  const params = obj.params || {};

  if (method === 'initialize') {
    const result = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
      },
      authMethods: [],
    };
    send({ jsonrpc: '2.0', id, result });
    return;
  }

  if (method === 'session/new') {
    if (!params.cwd || !params.cwd.startsWith('/')) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'cwd must be absolute' } });
      return;
    }
    currentSessionId = `sess_${Math.random().toString(36).slice(2, 10)}`;

    // Extract planner mode and config from params (Phase 7b)
    if (params.planner === 'off') {
      plannerMode = 'off';
    } else if (params.planner === 'gemini') {
      plannerMode = 'gemini';
    } else {
      plannerMode = 'mock'; // Default to mock
    }

    // Extract planner config options
    plannerConfig = {
      model: params.plannerModel || 'gemini-2.5-flash',
      timeout: params.plannerTimeout || 10000,
      maxCalls: params.plannerMaxCalls || 6,
      logText: params.plannerLogText || false,
    };

    // Connect to MCP servers if provided
    const mcpServers = params.mcpServers || [];
    if (mcpServers.length > 0) {
      connectMCPServers(mcpServers, params.cwd).then(
        () => {
          logger.line('info', { mcp_connected: mcpServers.map((s: MCPServerConfig) => s.name) });
          send({ jsonrpc: '2.0', id, result: { sessionId: currentSessionId } });
        },
        (err) => {
          logger.line('error', { mcp_connection_failed: err.message });
          // Still respond with session even if MCP fails (fallback to Phase 1)
          send({ jsonrpc: '2.0', id, result: { sessionId: currentSessionId } });
        }
      );
    } else {
      // No MCP servers, respond immediately
      send({ jsonrpc: '2.0', id, result: { sessionId: currentSessionId } });
    }
    return;
  }

  if (method === 'session/prompt') {
    if (!currentSessionId || params.sessionId !== currentSessionId) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'invalid session' } });
      return;
    }
    cancelled = false;

    // Check for resource_links in the prompt
    const prompt = params.prompt || [];
    const resourceLinks = prompt.filter((block: any) => block.type === 'resource_link');
    const textBlocks = prompt.filter((block: any) => block.type === 'text');
    const text = textBlocks.length > 0 ? textBlocks[0].text : '';

    // Log each resource_link
    resourceLinks.forEach((link: any) => {
      logger.line('info', { resource_link: link });
    });

    // Phase 7f: Check for confirmation responses (accept with or without colon)
    const lowerText = text.toLowerCase();
    if (lowerText === ':yes' || lowerText === ':no' || lowerText === 'yes' || lowerText === 'no') {
      const pendingPlan = pendingPlans.get(currentSessionId!);
      
      if (pendingPlan && Date.now() - pendingPlan.timestamp < 60000) { // 1 minute timeout
        // Clear the pending plan
        pendingPlans.delete(currentSessionId!);
        
        if (lowerText === ':yes' || lowerText === 'yes') {
          // Apply the pending plan
          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '✅ Applying confirmed changes...' },
          });
          
          // Apply the stored operations
          handlePendingPlan(pendingPlan.calls, currentSessionId, params.cwd || process.cwd()).then(
            () => {
              if (!cancelled) {
                send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
              } else {
                send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
              }
            },
            (err) => {
              logger.line('error', { pending_plan_failed: err.message });
              notify('session/update', {
                sessionId: currentSessionId,
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `Error applying plan: ${err.message}` },
              });
              send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
            }
          );
        } else {
          // Cancelled
          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '❌ Plan cancelled' },
          });
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      } else {
        notify('session/update', {
          sessionId: currentSessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'No pending plan to confirm' },
        });
        send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      }
      return;
    }
    
    // Check for :ask command (Phase 7a)
    if (text.startsWith(':ask ')) {
      handleAskCommand(text, currentSessionId, params.cwd || process.cwd(), id).then(
        () => {
          if (!cancelled) {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          } else {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          }
        },
        (err) => {
          logger.line('error', { ask_command_failed: err.message });
          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error: ${err.message}` },
          });
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      );
      return;
    }

    // Check for export command
    if (text.startsWith(':export')) {
      handleExportCommand(text, currentSessionId, params.cwd || process.cwd(), id).then(
        () => {
          if (!cancelled) {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          } else {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          }
        },
        (err) => {
          logger.line('error', { export_command_failed: err.message });
          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error: ${err.message}` },
          });
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      );
      return;
    }

    // Check for :ref command (Phase 7e)
    if (text.startsWith(':ref')) {
      handleRefCommand(text, currentSessionId, params.cwd || process.cwd()).then(
        () => {
          if (!cancelled) {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          } else {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          }
        },
        (err) => {
          logger.line('error', { ref_command_failed: err.message });
          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error: ${err.message}` },
          });
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      );
      return;
    }

    // Check for edit commands (crop, undo, redo, reset, white balance, exposure, contrast, saturation, vibrance, auto, hist)
    if (
      text.startsWith(':crop') ||
      text === ':undo' ||
      text === ':redo' ||
      text === ':reset' ||
      text.startsWith(':wb') ||
      text.startsWith(':exposure') ||
      text.startsWith(':contrast') ||
      text.startsWith(':saturation') ||
      text.startsWith(':vibrance') ||
      text.startsWith(':auto') ||
      text === ':hist'
    ) {
      handleEditCommand(text, currentSessionId).then(
        () => {
          if (!cancelled) {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          } else {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          }
        },
        (err) => {
          logger.line('error', { edit_command_failed: err.message });
          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error: ${err.message}` },
          });
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      );
      return;
    }

    // Handle resource links with MCP
    if (resourceLinks.length > 0 && mcpClients.size > 0) {
      handleResourceLinks(resourceLinks, currentSessionId).then(
        () => {
          if (!cancelled) {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          } else {
            send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          }
        },
        (err) => {
          logger.line('error', { resource_processing_failed: err.message });
          // Send error as text update
          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error processing resources: ${err.message}` },
          });
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      );
    } else {
      // Fallback to Phase 1 behavior - use promise instead of setTimeout
      Promise.resolve().then(() => {
        if (!cancelled) {
          let responseText: string;

          if (resourceLinks.length > 0) {
            // Acknowledge resources
            const firstBasename = resourceLinks[0].name || 'unknown';
            const moreText = resourceLinks.length > 1 ? ', ...' : '';
            responseText = `ack: ${resourceLinks.length} resources (${firstBasename}${moreText})`;
          } else if (text === 'ping') {
            responseText = 'pong';
          } else if (text === ':help' || text === 'help') {
            responseText = `Available commands:
:ask "text" - Ask AI to edit image with natural language
:ask --with-image "text" - Include image for visual analysis (Phase 7d)
  Examples:
  :ask "warm +0.5 ev, crop square"
  :ask --with-image "fix white balance, add contrast, rotate -1°, crop to subject"
  :ask --with-image "brighten, more vibrant, straighten horizon, export as final.jpg"
  :ask "export to ./Export/hero.jpg quality 95"
:load <path> - Load an image
:reset - Reset to original
:undo - Undo last operation
:redo - Redo operation
:stack - Show edit stack
:export - Export edited image`;
          } else {
            responseText = `echo:${text}`;
          }

          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: responseText },
          });
        }
        // Then respond with stopReason
        const stopReason = cancelled ? 'cancelled' : 'end_turn';
        send({ jsonrpc: '2.0', id, result: { stopReason } });
      });
    }
    return;
  }

  if (method === 'session/cancel') {
    cancelled = true;
    // Not a request in Phase 0; treat as notification but be lenient
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, result: { ok: true } });
    }
    return;
  }

  // Unknown
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
});

async function connectMCPServers(servers: MCPServerConfig[], cwd: string): Promise<void> {
  for (const server of servers) {
    try {
      const args = server.args || [];
      // Pass session cwd via MCP_ROOT env var for proper sandboxing
      const env: Record<string, string> = Object.fromEntries(
        Object.entries({ ...process.env, ...server.env, MCP_ROOT: cwd }).filter(([_, v]) => v !== undefined) as [
          string,
          string,
        ][]
      );

      // Let StdioClientTransport handle spawning - no manual spawn
      const transport = new StdioClientTransport({
        command: server.command,
        args,
        env,
      });

      const client = new Client(
        {
          name: `photo-agent-${server.name}`,
          version: '0.1.0',
        },
        {
          capabilities: {},
        }
      );

      // Connect the client (transport will spawn the process)
      await client.connect(transport);

      // Store only the client - transport manages process lifecycle
      mcpClients.set(server.name, client);

      logger.line('info', { mcp_server_connected: server.name });
    } catch (error: any) {
      logger.line('error', {
        mcp_server_failed: server.name,
        error: error.message,
      });
    }
  }
}

async function handleResourceLinks(resourceLinks: any[], sessionId: string): Promise<void> {
  // Get the first available MCP client (for now, we'll use 'image' if available)
  const client = mcpClients.get('image');
  if (!client) {
    throw new Error('No MCP image server available');
  }

  for (let i = 0; i < resourceLinks.length; i++) {
    if (cancelled) break;

    const link = resourceLinks[i];
    const toolCallId = `img_${i + 1}`;

    // Track loaded image for edit operations
    if (link.uri && link.uri.startsWith('file://')) {
      lastLoadedImage = link.uri;
      // Create edit stack if doesn't exist
      if (!imageStacks.has(link.uri)) {
        imageStacks.set(link.uri, new EditStackManager(link.uri));
      }
    }

    // Start tool call
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      rawInput: { uri: link.uri },
    });

    try {
      // Call read_image_meta
      const metaResult = await client.callTool({
        name: 'read_image_meta',
        arguments: { uri: link.uri },
      });

      // Find text content (human-readable metadata)
      const metaContent = Array.isArray(metaResult.content)
        ? metaResult.content.find((c: any) => c.type === 'text')
        : null;
      if (metaContent) {
        // Send metadata update
        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: metaContent.text },
            },
          ],
        });
      }

      // Call render_thumbnail
      const thumbResult = await client.callTool({
        name: 'render_thumbnail',
        arguments: { uri: link.uri, maxPx: 1024 },
      });

      // Find image content
      const thumbContent = Array.isArray(thumbResult.content)
        ? thumbResult.content.find((c: any) => c.type === 'image')
        : null;
      if (thumbContent) {
        // Send thumbnail update with structured image
        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: [
            {
              type: 'content',
              content: {
                type: 'image',
                data: thumbContent.data,
                mimeType: thumbContent.mimeType,
              },
            },
          ],
        });
      }

      // Mark as completed
      notify('session/update', {
        sessionId,
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
      });
    } catch (error: any) {
      logger.line('error', {
        tool_call_failed: toolCallId,
        error: error.message,
      });

      // Send error update
      notify('session/update', {
        sessionId,
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: `Failed to process ${link.name}: ${error.message}`,
            },
          },
        ],
      });
    }
  }
}

function send(obj: any) {
  logger.line('send', obj);
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function notify(method: string, params: any) {
  const msg = { jsonrpc: '2.0', method, params };
  send(msg);
}

// Phase 7f: Request user input for clarification or confirmation
async function requestUserInput(
  sessionId: string,
  prompt: string,
  options?: string[],
  context?: string,
  timeoutMs: number = 30000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = requestIdCounter++;
    
    // Set up timeout
    const timeout = setTimeout(() => {
      pendingInputRequests.delete(requestId);
      reject(new Error('User input timeout'));
    }, timeoutMs);
    
    // Store pending request
    pendingInputRequests.set(requestId, {
      resolve,
      reject,
      timeout,
    });
    
    // Send request_input notification
    const request: any = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'request_input',
      params: {
        sessionId,
        prompt,
        ...(options && { options }),
        ...(context && { context }),
      }
    };
    
    logger.line('info', { event: 'request_input', requestId, prompt });
    send(request);
  });
}

// Helper to format plan preview for confirmation
function formatPlanPreview(calls: PlannedCall[]): string {
  if (calls.length === 0) {
    return 'No operations planned.';
  }
  
  const lines = ['📋 Planned Operations:'];
  calls.forEach((call, i) => {
    let description = '';
    switch (call.fn) {
      case 'set_white_balance_temp_tint':
        if ('args' in call) {
          const { temp, tint } = call.args as any;
          description = `White balance: temp ${temp > 0 ? '+' : ''}${temp}, tint ${tint > 0 ? '+' : ''}${tint}`;
        }
        break;
      case 'set_exposure':
        if ('args' in call) {
          const { ev } = call.args as any;
          description = `Exposure: ${ev > 0 ? '+' : ''}${ev} EV`;
        }
        break;
      case 'set_contrast':
        if ('args' in call) {
          const { amt } = call.args as any;
          description = `Contrast: ${amt > 0 ? '+' : ''}${amt}`;
        }
        break;
      case 'set_saturation':
        if ('args' in call) {
          const { amt } = call.args as any;
          description = `Saturation: ${amt > 0 ? '+' : ''}${amt}`;
        }
        break;
      case 'set_vibrance':
        if ('args' in call) {
          const { amt } = call.args as any;
          description = `Vibrance: ${amt > 0 ? '+' : ''}${amt}`;
        }
        break;
      case 'set_crop':
        if ('args' in call) {
          const args = call.args as any;
          description = args.aspect ? `Crop to ${args.aspect}` : 'Custom crop';
        }
        break;
      case 'export_image':
        description = 'Export image';
        break;
      default:
        description = call.fn.replace(/_/g, ' ');
    }
    lines.push(`${i + 1}. ✓ ${description}`);
  });
  
  lines.push('\nApply these changes? [yes/no]: ');
  return lines.join('\n');
}

// Helper to get image metadata with caching
async function getImageMetadata(
  uri: string,
  client: Client
): Promise<{ width: number; height: number; mimeType?: string }> {
  // Check cache first
  if (imageMetadataCache.has(uri)) {
    return imageMetadataCache.get(uri)!;
  }

  try {
    const result = await client.callTool({
      name: 'read_image_meta',
      arguments: { uri },
    });

    const content = result.content as any;
    if (content?.[0]?.type === 'text') {
      const meta = JSON.parse(content[0].text);
      const metadata = {
        width: meta.width || 0,
        height: meta.height || 0,
        mimeType: meta.format ? `image/${meta.format.toLowerCase()}` : undefined,
      };

      // Cache the result
      imageMetadataCache.set(uri, metadata);
      return metadata;
    }
  } catch (error) {
    logger.line('error', { get_image_metadata_failed: error });
  }

  // Return defaults if metadata fetch fails
  const defaults = { width: 0, height: 0, mimeType: 'image/jpeg' };
  imageMetadataCache.set(uri, defaults);
  return defaults;
}

// Map preview coordinates to original image coordinates (Phase 7c)
// Accounts for crop and rotation transformations
function mapPreviewToOriginal(
  x: number,
  y: number,
  stack: EditStack,
  originalWidth: number,
  originalHeight: number
): { x: number; y: number; clamped: boolean } {
  let mappedX = x;
  let mappedY = y;
  let wasClamped = false;

  // Process operations in reverse order (undo transformations)
  const geometryOps = stack.ops.filter((op: any) => op.op === 'crop').reverse();

  for (const op of geometryOps) {
    if (op.op === 'crop') {
      const cropOp = op as any;

      // Handle rotation inverse
      if (cropOp.angleDeg) {
        // Rotate point back by negative angle
        const angle = (-cropOp.angleDeg * Math.PI) / 180;
        const centerX = 0.5;
        const centerY = 0.5;

        // Translate to origin
        const translatedX = mappedX - centerX;
        const translatedY = mappedY - centerY;

        // Apply inverse rotation
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rotatedX = translatedX * cos - translatedY * sin;
        const rotatedY = translatedX * sin + translatedY * cos;

        // Translate back
        mappedX = rotatedX + centerX;
        mappedY = rotatedY + centerY;
      }

      // Handle crop inverse
      if (cropOp.rectNorm) {
        const [cropX, cropY, cropW, cropH] = cropOp.rectNorm;

        // Map from cropped space back to original space
        mappedX = cropX + mappedX * cropW;
        mappedY = cropY + mappedY * cropH;
      }
    }
  }

  // Clamp to valid range [0,1]
  if (mappedX < 0 || mappedX > 1 || mappedY < 0 || mappedY > 1) {
    wasClamped = true;
    mappedX = Math.max(0, Math.min(1, mappedX));
    mappedY = Math.max(0, Math.min(1, mappedY));
  }

  return { x: mappedX, y: mappedY, clamped: wasClamped };
}

// Phase 7f: Handle applying a pending plan after confirmation
async function handlePendingPlan(calls: PlannedCall[], sessionId: string, cwd: string): Promise<void> {
  // Get the current image and stack
  if (!lastLoadedImage) {
    throw new Error('No image loaded');
  }
  
  const stackManager = imageStacks.get(lastLoadedImage);
  if (!stackManager) {
    throw new Error('No edit stack for current image');
  }
  
  const client = mcpClients.get('image');
  if (!client) {
    throw new Error('No MCP image server available');
  }
  
  // Apply the operations
  await withSpan('pending_plan.apply', async (span) => {
    span.setAttributes({
      'operations.count': calls.length,
      'session_id': sessionId
    });
    
    const appliedOps: string[] = [];
    
    for (const call of calls) {
      switch (call.fn) {
        case 'set_white_balance_temp_tint': {
          const { temp, tint } = call.args;
          stackManager.addWhiteBalance({
            method: 'temp_tint',
            temp,
            tint,
          });
          appliedOps.push(`WB(temp ${temp > 0 ? '+' : ''}${temp} tint ${tint > 0 ? '+' : ''}${tint})`);
          break;
        }
        
        case 'set_exposure': {
          const { ev } = call.args;
          stackManager.addExposure({ ev });
          appliedOps.push(`Exposure ${ev > 0 ? '+' : ''}${ev} EV`);
          break;
        }
        
        case 'set_contrast': {
          const { amt } = call.args;
          stackManager.addContrast({ amt });
          appliedOps.push(`Contrast ${amt > 0 ? '+' : ''}${amt}`);
          break;
        }
        
        case 'set_saturation': {
          const { amt } = call.args;
          stackManager.addSaturation({ amt });
          appliedOps.push(`Saturation ${amt > 0 ? '+' : ''}${amt}`);
          break;
        }
        
        case 'set_vibrance': {
          const { amt } = call.args;
          stackManager.addVibrance({ amt });
          appliedOps.push(`Vibrance ${amt > 0 ? '+' : ''}${amt}`);
          break;
        }
        
        case 'set_crop': {
          const { aspect } = call.args;
          if (aspect) {
            stackManager.addCrop({ aspect });
            appliedOps.push(`Crop ${aspect}`);
          }
          break;
        }
        
        case 'export_image': {
          // Export will be handled after the preview is rendered
          appliedOps.push('Export (pending)');
          break;
        }
        
        case 'undo':
        case 'redo':
        case 'reset':
          // These operations should be handled separately if needed
          break;
      }
    }
    
    span.setAttributes({
      'operations.applied': appliedOps.length,
      'operations.list': appliedOps.join(', ')
    });
    
    // Render preview
    await withSpan('preview.render', async (previewSpan) => {
      const previewResult = await client.callTool({
        name: 'render_preview',
        arguments: {
          uri: lastLoadedImage,
          editStack: stackManager.getStack(),
          maxPx: 512,
        },
      });
      
      previewSpan.setAttributes({
        'preview.rendered': true,
        'preview.max_px': 512
      });
      
      // Send the preview image
      const content = previewResult.content as any;
      if (content?.[0]?.type === 'image') {
        const imageData = content[0].data;
        const mimeType = content[0].mimeType || 'image/jpeg';
        
        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId: 'pending_plan_preview',
          status: 'completed',
          content: [{ type: 'image', data: imageData, mimeType }],
        });
      }
    });
    
    // Handle export if it was in the plan
    const exportCall = calls.find(c => c.fn === 'export_image');
    if (exportCall && 'args' in exportCall) {
      await withSpan('pending_plan.export', async (exportSpan) => {
        const result = await client.callTool({
          name: 'export_image',
          arguments: {
            uri: lastLoadedImage,
            editStack: stackManager.getStack(),
            ...exportCall.args,
          },
        });
        
        const content = result.content as any;
        if (content?.[0]?.type === 'text') {
          const exportData = JSON.parse(content[0].text);
          notify('session/update', {
            sessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { 
              type: 'text', 
              text: `📁 Exported to: ${exportData.path}`
            },
          });
        }
      });
    }
    
    // Summary
    notify('session/update', {
      sessionId,
      sessionUpdate: 'agent_message_chunk',
      content: { 
        type: 'text', 
        text: `✅ Applied ${appliedOps.length} operations: ${appliedOps.join(', ')}`
      },
    });
  });
}

async function handleAskCommand(command: string, sessionId: string, cwd: string, requestId: number): Promise<void> {
  // Parse command flags early to determine mode (Phase 7f)
  let confirmMode = false;
  let autoConfirm = false;
  const commandLower = command.toLowerCase();
  if (commandLower.includes('--confirm')) {
    confirmMode = true;
  }
  if (commandLower.includes('--auto-confirm')) {
    autoConfirm = true;
  }
  
  // Store export info if needed
  let exportInfo: { 
    call: PlannedCall, 
    stackManager: EditStackManager,
    client: any,
    lastLoadedImage: string,
    sessionId: string,
    cwd: string,
    requestId: number
  } | undefined;
  
  // Main processing in span
  await withSpan('ask_command', async (span) => {
    // Increment turn counter
    turnCounter++;
    
    // Add trace ID to logs
    const traceId = getTraceId();
    logger.line('info', { handleAskCommand_called: true, command, plannerMode, traceId });
    
    // Set span attributes
    span.setAttributes({
      'command': command,
      'session_id': sessionId,
      'planner_mode': plannerMode,
      'request_id': requestId,
      'turn_id': turnCounter,
      // Phase 7f attributes
      'confirm_mode': confirmMode,
      'auto_confirm': autoConfirm
    });

    // Check if planner is disabled
    if (plannerMode === 'off') {
      addSpanEvent('planner_disabled');
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Planner disabled. Use --planner=mock or --planner=gemini to enable.' },
      });
      return;
    }

  // Parse command early to check for --with-image flag
  const hasWithImageFlag = command.includes('--with-image');

  // Check if we have an image loaded
  if (!lastLoadedImage) {
    if (hasWithImageFlag) {
      throw new Error('No image loaded. Use :open <path> to load an image first, or remove --with-image flag.');
    } else {
      throw new Error('No image loaded. Please load an image first.');
    }
  }

  const stackManager = imageStacks.get(lastLoadedImage);
  if (!stackManager) {
    throw new Error('No edit stack for current image');
  }

  const client = mcpClients.get('image');
  if (!client) {
    throw new Error('No MCP image server available');
  }

  // Parse command for flags (Phase 7c/7e/7f)
  let withImage = false;
  let withRef: string | null = null;
  let showDeltas = false;
  let dryRun = false;
  // confirmMode and autoConfirm already parsed at function start
  let askText = command.substring(5).trim(); // Remove ":ask "

  // Parse flags
  const flagPattern = /^(--[\w-]+)(?:\s+([^\s]+))?\s*/;
  while (flagPattern.test(askText)) {
    const match = askText.match(flagPattern)!;
    const flag = match[1];
    const value = match[2];
    
    if (flag === '--with-image') {
      withImage = true;
      askText = askText.substring(match[0].length).trim();
    } else if (flag === '--ref') {
      if (!value) {
        throw new Error('--ref flag requires a path');
      }
      withRef = value;
      askText = askText.substring(match[0].length).trim();
    } else if (flag === '--show-deltas') {
      showDeltas = true;
      askText = askText.substring(match[0].length).trim();
    } else if (flag === '--dry-run') {
      dryRun = true;
      askText = askText.substring(match[0].length).trim();
    } else if (flag === '--confirm') {
      confirmMode = true;
      askText = askText.substring(match[0].length).trim();
    } else if (flag === '--auto-confirm') {
      autoConfirm = true;
      askText = askText.substring(match[0].length).trim();
    } else {
      break; // Unknown flag, treat as part of text
    }
  }

  if (!askText) {
    throw new Error('No text provided. Usage: :ask [--with-image] "warmer, +0.5 ev, crop square"');
  }

  // Select planner based on configuration
  let planner: Planner;
  if (plannerMode === 'gemini') {
    planner = new GeminiPlanner(plannerConfig);
  } else {
    planner = new MockPlanner();
  }

  // Build planner state for context (Phase 7b)
  const imageMeta = await getImageMetadata(lastLoadedImage, client);
  const plannerState: GeminiPlannerState = {
    image: {
      name: path.basename(lastLoadedImage),
      w: imageMeta.width,
      h: imageMeta.height,
      mime: imageMeta.mimeType || 'image/jpeg',
    },
    stackSummary: stackManager.getStackSummary(),
    limits: {
      temp: [PLANNER_CLAMPS.temp.min, PLANNER_CLAMPS.temp.max],
      ev: [PLANNER_CLAMPS.ev.min, PLANNER_CLAMPS.ev.max],
      contrast: [PLANNER_CLAMPS.contrast.min, PLANNER_CLAMPS.contrast.max],
      angle: [PLANNER_CLAMPS.angleDeg.min, PLANNER_CLAMPS.angleDeg.max],
    },
  };

  // Phase 7e: Handle reference image
  if (withRef) {
    // Load reference if provided via --ref flag
    const resolvedPath = path.isAbsolute(withRef) ? withRef : path.join(cwd, withRef);
    const fileUri = pathToFileURL(resolvedPath).toString();
    
    // Check if file exists
    try {
      await fs.stat(resolvedPath);
    } catch (err) {
      throw new Error(`Reference file not found: ${withRef}`);
    }
    
    // Compute reference stats
    const refStats = await withSpan('ref.compute_stats', async (refSpan) => {
      refSpan.setAttributes({
        'ref.path': path.basename(resolvedPath)
      });
      
      const result = await client.callTool({
        name: 'image_stats',
        arguments: {
          uri: fileUri,
          maxPx: 1024,
        },
      });
      
      const content = result.content as any;
      if (content?.[0]?.type === 'text') {
        return JSON.parse(content[0].text);
      }
      throw new Error('Failed to compute reference image statistics');
    });
    
    // Update global reference
    referenceImage = {
      path: resolvedPath,
      stats: refStats,
    };
  }
  
  // If we have a reference image, compute stats and deltas
  if (referenceImage) {
    // Compute current image stats
    const targetStats = await withSpan('target.compute_stats', async (targetSpan) => {
      targetSpan.setAttributes({
        'target.uri': lastLoadedImage || ''
      });
      
      // First apply current edit stack to get the actual preview state
      const previewResult = await client.callTool({
        name: 'render_preview',
        arguments: {
          uri: lastLoadedImage,
          editStack: stackManager.getStack(),
          maxPx: 1024,
          format: 'jpeg',
          quality: 60,
        },
      });
      
      // Then compute stats on the preview (we need to save it temporarily)
      // For now, compute stats on the base image (simplified)
      // TODO: Ideally we'd compute stats on the preview with edits applied
      const result = await client.callTool({
        name: 'image_stats',
        arguments: {
          uri: lastLoadedImage,
          maxPx: 1024,
        },
      });
      
      const content = result.content as any;
      if (content?.[0]?.type === 'text') {
        return JSON.parse(content[0].text);
      }
      throw new Error('Failed to compute target image statistics');
    });
    
    // Compute deltas locally
    const suggestedDeltas = await withSpan('look.delta_compute', async (deltaSpan) => {
      const deltas = computeDeltas(targetStats as ImageStats, referenceImage!.stats as ImageStats);
      
      deltaSpan.setAttributes({
        'delta.a': referenceImage!.stats.AB.a_mean - targetStats.AB.a_mean,
        'delta.b': referenceImage!.stats.AB.b_mean - targetStats.AB.b_mean,
        'delta.L': referenceImage!.stats.L.p50 - targetStats.L.p50,
        'delta.contrast': referenceImage!.stats.contrast_index - targetStats.contrast_index,
        'delta.colorfulness': referenceImage!.stats.sat.colorfulness - targetStats.sat.colorfulness,
        'suggested.temp': deltas.temp || 0,
        'suggested.tint': deltas.tint || 0,
        'suggested.ev': deltas.ev || 0,
        'suggested.contrast': deltas.contrast || 0,
        'suggested.vibrance': deltas.vibrance || 0,
        'suggested.saturation': deltas.saturation || 0,
      });
      
      return deltas;
    });
    
    // Add to planner state
    plannerState.refStats = referenceImage.stats;
    plannerState.suggestedDeltas = suggestedDeltas;
    
    // Show deltas if requested
    if (showDeltas) {
      const deltaDisplay = formatDeltasForDisplay(suggestedDeltas);
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: deltaDisplay },
      });
      
      if (dryRun) {
        // Exit early if dry run
        return;
      }
    }
    
    // Check if all deltas are below epsilon
    if (areAllDeltasBelowEpsilon(suggestedDeltas)) {
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Image already matches reference (all deltas below threshold).' },
      });
      
      if (!askText || askText.toLowerCase() === 'match the reference look') {
        // No additional text, just matching reference, and already matches
        return;
      }
    }
  }

  // Capture preview image if --with-image flag is present (Phase 7c)
  let imageB64: string | undefined;
  if (withImage) {
    imageB64 = await withSpan('preview.capture', async (previewSpan) => {
      try {
        previewSpan.setAttributes({
          'image.uri': lastLoadedImage || '',
          'image.max_px': 1024,
          'image.format': 'jpeg',
          'image.quality': 60
        });
        
        // Generate 1024px preview using JPEG for smaller size
        const previewResult = await client.callTool({
          name: 'render_preview',
          arguments: {
            uri: lastLoadedImage,
            editStack: stackManager.getStack(),
            maxPx: 1024,
            format: 'jpeg',
            quality: 60,  // Reduced from 80 to optimize size
          },
        });

        // Extract image content
        const content = previewResult.content as any;
        if (content?.[0]?.type === 'image') {
          // The image is already base64 encoded from the MCP server
          const data = content[0].data;
          const imageBytes = Math.round(data.length * 0.75);
          
          previewSpan.setAttributes({
            'image.bytes': imageBytes,
            'image.captured': true
          });
          
          // Log image capture
          logger.line('info', {
            preview_captured: true,
            imageBytes,
            traceId: getTraceId()
          });
          
          return data;
        }
        return undefined;
      } catch (error: any) {
        previewSpan.recordException(error);
        logger.line('error', { preview_capture_failed: error.message, traceId: getTraceId() });
        // Continue without image on error
        return undefined;
      }
    });
  }

  // Plan the operations
  const planResult = await withSpan('planner.execute', async (plannerSpan) => {
    plannerSpan.setAttributes({
      'planner.type': plannerMode,
      'planner.has_image': !!imageB64,
      'planner.text': askText,
      'planner.ref.present': !!referenceImage,
      'planner.ref.basename': referenceImage ? path.basename(referenceImage.path) : undefined,
    });
    
    const startTime = Date.now();
    const PLANNER_TIMEOUT_MS = 3000; // 3 second timeout target
    
    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        const elapsed = Date.now() - startTime;
        logger.line('info', {
          event: 'planner_timeout_would_trigger',
          elapsed_ms: elapsed,
          timeout_ms: PLANNER_TIMEOUT_MS
        });
        // Don't actually reject, just log that we would have
        // reject(new Error(`Planner timeout after ${elapsed}ms`));
      }, PLANNER_TIMEOUT_MS);
    });
    
    // Race between planner and timeout (but don't actually timeout)
    const plannerPromise = planner.plan({
      text: askText,
      state: plannerState,
      imageB64,
    });
    
    // Wait for planner (not actually racing for now, just monitoring)
    const result = await plannerPromise;
    const planningTime = Date.now() - startTime;
    
    // Log if we exceeded timeout
    if (planningTime > PLANNER_TIMEOUT_MS) {
      addSpanEvent('planner.timeout_exceeded', {
        'planner.timeout_ms': PLANNER_TIMEOUT_MS,
        'planner.actual_ms': planningTime
      });
      plannerSpan.setAttributes({
        'planner.timeout_exceeded': true
      });
    }
    
    // Create calls list string
    const callsList = result.calls.map(c => {
      if (c.fn === 'set_white_balance_temp_tint' || c.fn === 'set_white_balance_gray') {
        return 'wb';
      } else if (c.fn === 'set_exposure') {
        return 'ev';
      } else if (c.fn === 'set_contrast') {
        return 'contrast';
      } else if (c.fn === 'set_saturation') {
        return 'saturation';
      } else if (c.fn === 'set_vibrance') {
        return 'vibrance';
      } else if (c.fn === 'set_rotate') {
        return 'rotate';
      } else if (c.fn === 'set_crop') {
        return 'crop';
      } else if (c.fn === 'export_image') {
        return 'export';
      } else {
        return c.fn.replace('set_', '');
      }
    }).join(',');
    
    plannerSpan.setAttributes({
      'planner.latency_ms': planningTime,
      'planner.calls_count': result.calls.length,
      'planner.has_notes': !!result.notes?.length,
      'planner.calls_list': callsList
    });
    
    return { ...result, planningTime };
  });
  
  const { calls, notes, planningTime, confidence, needsClarification } = planResult;
  
  // Phase 7f: Handle clarification if needed
  let finalCalls = calls;
  if (needsClarification && !autoConfirm) {
    await withSpan('clarification.request', async (clarifySpan) => {
      clarifySpan.setAttributes({
        'clarification.needed': true,
        'clarification.confidence': confidence || 0,
        'clarification.question': needsClarification.question
      });
      
      // Show current best guess
      if (calls.length > 0) {
        notify('session/update', {
          sessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { 
            type: 'text', 
            text: `❓ I need clarification (confidence: ${(confidence || 0).toFixed(1)})\n\nBest guess: ${calls.map(c => c.fn).join(', ')}`
          },
        });
      }
      
      // Format clarification request
      let clarificationPrompt = needsClarification.question;
      if (needsClarification.options && needsClarification.options.length > 0) {
        clarificationPrompt += '\n\nOptions:\n';
        needsClarification.options.forEach((opt, i) => {
          clarificationPrompt += `${i + 1}. ${opt}\n`;
        });
      }
      if (needsClarification.context) {
        clarificationPrompt += `\n${needsClarification.context}`;
      }
      
      try {
        const userResponse = await requestUserInput(
          sessionId,
          clarificationPrompt,
          needsClarification.options
        );
        
        addSpanEvent('clarification.received', {
          'clarification.response': userResponse.substring(0, 100)
        });
        
        // Re-run planner with clarification
        const clarifiedResult = await planner.plan({
          text: `${askText} (clarification: ${userResponse})`,
          state: plannerState,
          imageB64,
        });
        
        finalCalls = clarifiedResult.calls;
        clarifySpan.setAttributes({
          'clarification.new_calls': finalCalls.length
        });
      } catch (err: any) {
        // Timeout or error - proceed with best guess
        addSpanEvent('clarification.failed', {
          'clarification.error': err.message || 'Unknown error'
        });
        notify('session/update', {
          sessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { 
            type: 'text', 
            text: 'Clarification timeout - proceeding with best guess' 
          },
        });
      }
    });
  }
  
  // Phase 7f: Handle confirmation if needed
  // Check if either --confirm or --auto-confirm was used
  if ((confirmMode || autoConfirm) && finalCalls.length > 0) {
    let shouldReturn = false;
    await withSpan('confirmation.request', async (confirmSpan) => {
      // Only auto-confirm if autoConfirm flag is set AND confidence is high
      // If user explicitly uses --confirm, always ask for confirmation
      const shouldAutoConfirm = autoConfirm && confidence && confidence >= 0.8;
      confirmSpan.setAttributes({
        'confirmation.mode': true,
        'confirmation.confidence': confidence || 0,
        'confirmation.auto': shouldAutoConfirm
      });
      
      if (shouldAutoConfirm) {
        // High confidence with --auto-confirm flag - auto-confirm
        notify('session/update', {
          sessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { 
            type: 'text', 
            text: `✅ High confidence (${confidence.toFixed(1)}) with auto-confirm - applying changes automatically` 
          },
        });
      } else {
        // Show plan preview and store it for later confirmation
        const planPreview = formatPlanPreview(finalCalls);
        
        // Log what we're about to send for debugging
        logger.line('info', {
          event: 'confirmation_preview',
          preview_length: planPreview.length,
          calls_count: finalCalls.length,
          session_id: sessionId
        });
        
        // Store the pending plan so we can apply it on next prompt
        pendingPlans.set(sessionId, {
          calls: finalCalls,
          timestamp: Date.now()
        });
        
        // Send the plan preview to the user
        const confirmationMessage = planPreview + '\n\nType ":yes" to apply or ":no" to cancel';
        notify('session/update', {
          sessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { 
            type: 'text', 
            text: confirmationMessage
          },
        });
        
        confirmSpan.setAttributes({
          'confirmation.pending': true,
          'confirmation.plan_stored': true
        });
        
        // Don't apply the changes yet - wait for user response
        shouldReturn = true;
      }
    });
    
    // Return early if we're waiting for confirmation
    if (shouldReturn) {
      return;
    }
  }

  // Log apply result
  const stackBefore = stackManager.getStack();
  const stackHashBefore = JSON.stringify(stackBefore).length; // Simple hash

  logger.line('info', { planner_output: { calls: finalCalls, notes } });

  // Track what was clamped and dropped
  const clampedValues: string[] = [];
  const appliedOps: string[] = [];
  const droppedOps: string[] = [];
  let hasExport = false;

  // Apply operations from planner calls
  await withSpan('operations.apply', async (applySpan) => {
    applySpan.setAttributes({
      'operations.planned': calls.length,
    });

    // Process each planned call
    for (const call of finalCalls) {
      if (cancelled) break;

      switch (call.fn) {
      case 'set_white_balance_temp_tint': {
        const { temp, tint } = call.args;

        // Check if we have an existing white balance operation to accumulate with
        const currentStack = stackManager.getStack();
        let lastWbOp: any = null;
        for (let i = currentStack.ops.length - 1; i >= 0; i--) {
          const op = currentStack.ops[i] as any;
          if (op.op === 'white_balance' && op.method === 'temp_tint') {
            lastWbOp = op;
            break;
          }
        }

        // If we have an existing temp_tint operation, add to it
        let finalTemp = temp;
        let finalTint = tint;
        if (lastWbOp) {
          finalTemp = (lastWbOp.temp || 0) + temp;
          finalTint = (lastWbOp.tint || 0) + tint;
        }

        const clampedTemp = Math.max(PLANNER_CLAMPS.temp.min, Math.min(PLANNER_CLAMPS.temp.max, finalTemp));
        const clampedTint = Math.max(PLANNER_CLAMPS.tint.min, Math.min(PLANNER_CLAMPS.tint.max, finalTint));

        if (clampedTemp !== finalTemp) {
          clampedValues.push(`temp ${finalTemp} → ${clampedTemp}`);
        }
        if (clampedTint !== finalTint) {
          clampedValues.push(`tint ${finalTint} → ${clampedTint}`);
        }

        stackManager.addWhiteBalance({
          method: 'temp_tint',
          temp: clampedTemp,
          tint: clampedTint,
        });
        appliedOps.push(
          `WB(temp ${clampedTemp > 0 ? '+' : ''}${clampedTemp} tint ${clampedTint > 0 ? '+' : ''}${clampedTint})`
        );
        break;
      }

      case 'set_white_balance_gray': {
        let { x, y } = call.args;

        // Map preview coordinates to original if we're in vision mode (Phase 7c)
        if (withImage && lastLoadedImage) {
          const imageMeta = await getImageMetadata(lastLoadedImage, client);
          const mapped = mapPreviewToOriginal(x, y, stackManager.getStack(), imageMeta.width, imageMeta.height);

          if (mapped.clamped) {
            clampedValues.push(
              `gray_point mapped to ${mapped.x.toFixed(2)},${mapped.y.toFixed(2)} from ${x.toFixed(2)},${y.toFixed(2)}`
            );
          }

          x = mapped.x;
          y = mapped.y;
        }

        const clampedX = Math.max(0, Math.min(1, x));
        const clampedY = Math.max(0, Math.min(1, y));

        stackManager.addWhiteBalance({
          method: 'gray_point',
          x: clampedX,
          y: clampedY,
        });
        appliedOps.push(`WB(gray ${clampedX.toFixed(2)},${clampedY.toFixed(2)})`);
        break;
      }

      case 'set_exposure': {
        const { ev } = call.args;

        // Check if we have an existing exposure operation to accumulate with
        const currentStack = stackManager.getStack();
        let lastExpOp: any = null;
        for (let i = currentStack.ops.length - 1; i >= 0; i--) {
          const op = currentStack.ops[i] as any;
          if (op.op === 'exposure') {
            lastExpOp = op;
            break;
          }
        }

        // If we have an existing exposure operation, add to it
        let finalEv = ev;
        if (lastExpOp) {
          finalEv = (lastExpOp.ev || 0) + ev;
        }

        const clampedEv = Math.max(PLANNER_CLAMPS.ev.min, Math.min(PLANNER_CLAMPS.ev.max, finalEv));

        if (clampedEv !== finalEv) {
          clampedValues.push(`ev ${finalEv.toFixed(1)} → ${clampedEv.toFixed(1)}`);
        }

        stackManager.addExposure({ ev: clampedEv });
        appliedOps.push(`EV ${clampedEv > 0 ? '+' : ''}${clampedEv.toFixed(2)}`);
        break;
      }

      case 'set_contrast': {
        const { amt } = call.args;

        // Check if we have an existing contrast operation to accumulate with
        const currentStack = stackManager.getStack();
        let lastContrastOp: any = null;
        for (let i = currentStack.ops.length - 1; i >= 0; i--) {
          const op = currentStack.ops[i] as any;
          if (op.op === 'contrast') {
            lastContrastOp = op;
            break;
          }
        }

        // If we have an existing contrast operation, add to it
        let finalAmt = amt;
        if (lastContrastOp) {
          finalAmt = (lastContrastOp.amt || 0) + amt;
        }

        const clampedAmt = Math.max(PLANNER_CLAMPS.contrast.min, Math.min(PLANNER_CLAMPS.contrast.max, finalAmt));

        if (clampedAmt !== finalAmt) {
          clampedValues.push(`contrast ${finalAmt} → ${clampedAmt}`);
        }

        stackManager.addContrast({ amt: clampedAmt });
        appliedOps.push(`Contrast ${clampedAmt > 0 ? '+' : ''}${clampedAmt}`);
        break;
      }

      case 'set_saturation': {
        const { amt } = call.args;
        const clampedAmt = Math.max(PLANNER_CLAMPS.saturation.min, Math.min(PLANNER_CLAMPS.saturation.max, amt));
        
        if (clampedAmt !== amt) {
          clampedValues.push(`saturation ${amt} → ${clampedAmt}`);
        }
        
        stackManager.addSaturation({ amt: clampedAmt });
        appliedOps.push(`Saturation ${clampedAmt > 0 ? '+' : ''}${clampedAmt}`);
        break;
      }

      case 'set_vibrance': {
        const { amt } = call.args;
        const clampedAmt = Math.max(PLANNER_CLAMPS.vibrance.min, Math.min(PLANNER_CLAMPS.vibrance.max, amt));
        
        if (clampedAmt !== amt) {
          clampedValues.push(`vibrance ${amt} → ${clampedAmt}`);
        }
        
        stackManager.addVibrance({ amt: clampedAmt });
        appliedOps.push(`Vibrance ${clampedAmt > 0 ? '+' : ''}${clampedAmt}`);
        break;
      }

      case 'set_rotate': {
        const { angleDeg } = call.args;
        const clampedAngle = Math.max(PLANNER_CLAMPS.angleDeg.min, Math.min(PLANNER_CLAMPS.angleDeg.max, angleDeg));
        
        if (clampedAngle !== angleDeg) {
          clampedValues.push(`rotate ${angleDeg}° → ${clampedAngle}°`);
        }
        
        // Rotation is handled as part of crop operation
        stackManager.addCrop({ angleDeg: clampedAngle });
        appliedOps.push(`Rotate ${clampedAngle > 0 ? '+' : ''}${clampedAngle}°`);
        break;
      }

      case 'set_crop': {
        let { aspect, rectNorm } = call.args;
        const options: any = {};

        if (aspect) {
          options.aspect = aspect;
          appliedOps.push(`Crop ${aspect}`);
        }
        if (rectNorm) {
          // Map preview coordinates to original if we're in vision mode (Phase 7d)
          if (withImage && lastLoadedImage) {
            const imageMeta = await getImageMetadata(lastLoadedImage, client);
            // Map each corner of the rectangle
            const [x, y, w, h] = rectNorm;
            const topLeft = mapPreviewToOriginal(x, y, stackManager.getStack(), imageMeta.width, imageMeta.height);
            const bottomRight = mapPreviewToOriginal(x + w, y + h, stackManager.getStack(), imageMeta.width, imageMeta.height);
            
            const mappedRect: [number, number, number, number] = [
              topLeft.x,
              topLeft.y,
              bottomRight.x - topLeft.x,
              bottomRight.y - topLeft.y
            ];
            
            if (topLeft.clamped || bottomRight.clamped) {
              clampedValues.push(
                `crop rect mapped to [${mappedRect.map(v => v.toFixed(2)).join(',')}] from [${rectNorm.map(v => v.toFixed(2)).join(',')}]`
              );
            }
            rectNorm = mappedRect;
          }
          
          options.rectNorm = rectNorm;
          if (!aspect) {
            appliedOps.push(`Crop rect`);
          }
        }

        if (Object.keys(options).length > 0) {
          stackManager.addCrop(options);
        }
        break;
      }

      case 'undo': {
        if (stackManager.undo()) {
          appliedOps.push('Undo');
        } else {
          appliedOps.push('Undo (nothing to undo)');
        }
        break;
      }

      case 'redo': {
        if (stackManager.redo()) {
          appliedOps.push('Redo');
        } else {
          appliedOps.push('Redo (nothing to redo)');
        }
        break;
      }

      case 'reset': {
        stackManager.reset();
        appliedOps.push('Reset');
        break;
      }

      case 'export_image': {
        hasExport = true;
        // Export will be handled after rendering (not counted as applied yet)
        droppedOps.push('export_image (deferred)');
        break;
      }
      
      default: {
        // Unknown operation
        const unknownCall = call as any;
        if (unknownCall.fn) {
          droppedOps.push(unknownCall.fn);
        }
        break;
      }
    }
  }

    // End apply operations span
    applySpan.setAttributes({
      'operations.applied': appliedOps.length,
      'operations.applied_list': appliedOps.join(', '),
      'operations.dropped': droppedOps.length,
      'operations.dropped_list': droppedOps.join(', '),
      'operations.clamped_count': clampedValues.length,
    });
  }); // End withSpan for operations.apply

  // Log apply result telemetry
  const stackAfter = stackManager.getStack();
  const stackHashAfter = JSON.stringify(stackAfter).length; // Simple hash
  logger.line('info', {
    event: 'apply_result',
    stackHashBefore,
    stackHashAfter,
    previewMs: planningTime,
    operationsApplied: appliedOps.length,
    valuesClamped: clampedValues.length,
  });

  // Build summary text
  let summaryText = '';
  if (appliedOps.length > 0) {
    summaryText = `Applied: ${appliedOps.join(', ')}\n`;
  }
  if (clampedValues.length > 0) {
    summaryText += `Clamped: ${clampedValues.join(', ')}\n`;
  }
  if (notes && notes.length > 0) {
    summaryText += notes.join('\n') + '\n';
  }
  summaryText += `Stack: ${stackManager.getStackSummary()}`;

  // Add span event for summary generation
  addSpanEvent('summary.sent', {
    'summary.applied_ops': appliedOps.join(', '),
    'summary.clamped_count': clampedValues.length,
    'summary.stack': stackManager.getStackSummary(),
  });

  // Send text summary first
  notify('session/update', {
    sessionId,
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: summaryText },
  });

  // Render preview (only if we have operations)
  if (stackManager.hasOperations()) {
    await withSpan('preview.render', async (renderSpan) => {
      const toolCallId = 'ask_render';
      const stack = stackManager.getStack();
      
      // Get image dimensions from metadata cache
      const imageMeta = lastLoadedImage ? imageMetadataCache.get(lastLoadedImage) : undefined;
      const opsListStr = stack.ops.map(op => op.op).join(',');
      
      renderSpan.setAttributes({
        'preview.stack_size': stack.ops.length,
        'preview.max_px': 1024,
        'preview.image_width': imageMeta?.width || 0,
        'preview.image_height': imageMeta?.height || 0,
        'preview.ops_list': opsListStr
      });

      notify('session/update', {
        sessionId,
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'in_progress',
        rawInput: { operation: 'render_preview' },
      });

      try {
        const previewResult = await client.callTool({
          name: 'render_preview',
          arguments: {
            uri: lastLoadedImage,
            editStack: stack,
            maxPx: 1024,
            format: 'jpeg',
            quality: 60,  // Reduced for optimization
          },
        });

        const content = previewResult.content as any;
        if (content?.[0]?.type === 'image') {
          const imageData = content[0].data;
          const mimeType = content[0].mimeType || 'image/png';
          
          renderSpan.setAttributes({
            'preview.output_type': mimeType,
            'preview.output_size': imageData?.length || 0,
          });

          notify('session/update', {
            sessionId,
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{ type: 'image', data: imageData, mimeType }],
          });
          
        }
      } catch (error: any) {
        renderSpan.recordException(error);
        renderSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        logger.line('error', { render_preview_failed: error.message });
        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          error: { message: error.message },
        });
      }
    }); // End preview.render span
  }

  // Store export info for processing after span closes
  if (hasExport) {
    const exportCall = calls.find((c) => c.fn === 'export_image');
    if (exportCall) {
      exportInfo = { 
        call: exportCall, 
        stackManager,
        client,
        lastLoadedImage,
        sessionId,
        cwd,
        requestId
      };
      // Just notify that export will happen
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\nExport requested, will process after preview...' },
      });
    }
  }
  }); // End of withSpan
  
  // Handle export outside of main span
  if (exportInfo) {
    await withSpan('export.execute', async (exportSpan) => {
      const { 
        call: exportCall, 
        stackManager, 
        client,
        lastLoadedImage,
        sessionId,
        cwd,
        requestId
      } = exportInfo!;
      const args = (exportCall as any).args || {};
      
      // Set export span attributes
      exportSpan.setAttributes({
        'export.source': lastLoadedImage,
        'export.format': args.format || 'jpeg',
        'export.quality': args.quality || 90,
        'export.has_destination': !!args.dst,
        'export.overwrite': args.overwrite || false,
        'export.stack_size': stackManager.getStack().ops.length
      });

      // Build export options
      const exportOptions: any = {
        format: args.format || 'jpeg',
        quality: args.quality || 90,
        chromaSubsampling: '4:2:0',
        stripExif: true,
        colorProfile: 'srgb',
        overwrite: args.overwrite || false,
      };

      // Determine destination path
      let dstPath: string;
      if (args.dst) {
        dstPath = path.resolve(cwd, args.dst);
      } else {
        const origName = path.basename(lastLoadedImage, path.extname(lastLoadedImage));
        const ext = exportOptions.format === 'png' ? '.png' : '.jpg';
        dstPath = path.resolve(cwd, 'Export', `${origName}_edit${ext}`);
      }

      // Add span event for destination path
      addSpanEvent('export.destination_resolved', {
        'export.destination': dstPath,
        'export.destination_directory': path.dirname(dstPath)
      });
      
      // Request permission for export
      const permId = requestId + 2000; // Use offset to avoid ID collision
      const operations: PermissionOperation[] = [
        {
          kind: 'write_file',
          uri: pathToFileURL(dstPath).href,
          bytesApprox: 2500000, // ~2.5MB estimate
        },
        {
          kind: 'write_file',
          uri: pathToFileURL(dstPath + '.editstack.json').href,
          bytesApprox: JSON.stringify(stackManager.getStack()).length + 100,
        },
      ];

      const permissionRequest = {
        jsonrpc: '2.0',
        id: permId,
        method: 'session/request_permission',
        params: {
          sessionId,
          title: 'Export edited image',
          explanation: `Write edited image to ${path.basename(dstPath)}`,
          operations,
        },
      };

      // Wrap permission request in a span
      const approved = await withSpan('permission.request', async (permSpan) => {
        permSpan.setAttributes({
          'permission.destination': path.basename(dstPath),
          'permission.operations_count': operations.length,
          'permission.bytes_approx': operations.reduce((sum, op) => sum + (op.bytesApprox || 0), 0)
        });
        
        // Check for auto-approve environment variable
        const autoApprove = process.env.PHOTO_AGENT_AUTO_APPROVE_EXPORT === 'true';
        
        if (autoApprove) {
          // Auto-approve exports for testing
          logger.line('info', { 
            event: 'export_auto_approved',
            reason: 'PHOTO_AGENT_AUTO_APPROVE_EXPORT=true',
            destination: path.basename(dstPath)
          });
          
          // Add span event for auto-approval
          addSpanEvent('permission.auto_approved', {
            'permission.auto_approve': true,
            'permission.destination': path.basename(dstPath)
          });
          
          permSpan.setAttributes({
            'permission.auto_approved': true,
            'permission.granted': true
          });
          
          return true;
        } else {
          // Normal permission flow
          const result = await new Promise<boolean>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingPermissions.delete(permId);
              logger.line('info', { permission_timeout: permId });
              addSpanEvent('permission.timeout');
              permSpan.setAttributes({
                'permission.timeout': true,
                'permission.granted': false
              });
              resolve(false); // Auto-deny on timeout
            }, 15000); // 15 second timeout

            pendingPermissions.set(permId, { resolve, reject, timeout });
            send(permissionRequest);
          });
          
          permSpan.setAttributes({
            'permission.granted': result
          });
          
          return result;
        }
      });

      if (approved) {
        // Add span event for permission granted
        addSpanEvent('export.permission_granted');
        exportSpan.setAttributes({
          'export.permission_granted': true
        });
        
        const toolCallId = 'ask_export';

        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          rawInput: { operation: 'export', dst: dstPath },
        });

        try {
          // Ensure Export directory exists
          const exportDir = path.dirname(dstPath);
          await fs.mkdir(exportDir, { recursive: true });

          const stack = stackManager.getStack();
          const dstUri = pathToFileURL(dstPath).href;

          // Wrap MCP call in span
          const exportResult = await withSpan('mcp.commit_version', async (mcpSpan) => {
            mcpSpan.setAttributes({
              'mcp.source': path.basename(lastLoadedImage),
              'mcp.destination': path.basename(dstPath),
              'mcp.format': exportOptions.format,
              'mcp.quality': exportOptions.quality,
              'mcp.stack_size': stack.ops.length
            });
            
            const result = await client.callTool({
              name: 'commit_version',
              arguments: {
                uri: lastLoadedImage,
                editStack: stack,
                dstUri,
                ...exportOptions,
              },
            });
            
            return result;
          });

          // Log export result telemetry
          logger.line('info', {
            event: 'export_result',
            destination: dstPath,
            format: exportOptions.format,
            quality: exportOptions.quality,
            success: true,
          });
          
          // Get actual file size
          let exportBytes = 0;
          try {
            const stats = await fs.stat(dstPath);
            exportBytes = stats.size;
          } catch (e) {
            // Ignore stat errors
          }
          
          // Add span event for successful export
          addSpanEvent('export.completed', {
            'export.destination': dstPath,
            'export.format': exportOptions.format,
            'export.quality': exportOptions.quality,
            'export.bytes': exportBytes
          });
          exportSpan.setAttributes({
            'export.success': true,
            'export.final_destination': dstPath,
            'export.bytes': exportBytes
          });

          notify('session/update', {
            sessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Export complete: ${dstPath}` },
          });
        } catch (error: any) {
          logger.line('error', { export_failed: error.message });
          notify('session/update', {
            sessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Export failed: ${error.message}` },
          });
        }
      } else {
        // Add span event for permission denied
        addSpanEvent('export.permission_denied');
        exportSpan.setAttributes({
          'export.permission_granted': false,
          'export.cancelled': true
        });
        
        notify('session/update', {
          sessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Export cancelled by user' },
        });
      }
    });
  }
}

async function handleRefCommand(command: string, sessionId: string, cwd: string): Promise<void> {
  await withSpan('ref_command', async (span) => {
    span.setAttributes({
      'command': command,
      'session_id': sessionId
    });

    const parts = command.split(' ').filter(p => p);
    const subCommand = parts[1]; // 'open' or 'clear'
    
    if (subCommand === 'clear') {
      // Clear reference image
      referenceImage = null;
      addSpanEvent('ref.cleared');
      
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Reference image cleared.' },
      });
      return;
    }
    
    if (subCommand === 'open') {
      const refPath = parts.slice(2).join(' ');
      if (!refPath) {
        throw new Error('Usage: :ref open <path>');
      }
      
      // Resolve path relative to CWD
      const resolvedPath = path.isAbsolute(refPath) ? refPath : path.join(cwd, refPath);
      const fileUri = pathToFileURL(resolvedPath).toString();
      
      // Check if file exists
      try {
        await fs.stat(resolvedPath);
      } catch (err) {
        throw new Error(`Reference file not found: ${refPath}`);
      }
      
      // Get MCP client
      const client = mcpClients.get('image');
      if (!client) {
        throw new Error('No MCP image server available');
      }
      
      // Compute file hash for caching
      const fileStats = await fs.stat(resolvedPath);
      const fileBuffer = await fs.readFile(resolvedPath);
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex').substring(0, 16);
      const cacheKey = `${fileHash}_${fileStats.size}_${fileStats.mtime.getTime()}`;
      
      // Check cache first
      let stats = referenceStatsCache.get(cacheKey);
      
      if (!stats) {
        // Compute stats using MCP tool
        stats = await withSpan('ref.load_stats', async (loadSpan) => {
          loadSpan.setAttributes({
            'ref.path': path.basename(resolvedPath),
            'ref.size': fileStats.size,
            'ref.hash': fileHash
          });
          
          const result = await client.callTool({
            name: 'image_stats',
            arguments: {
              uri: fileUri,
              maxPx: 1024,
            },
          });
          
          const content = result.content as any;
          if (content?.[0]?.type === 'text') {
            const parsedStats = JSON.parse(content[0].text);
            loadSpan.setAttributes({
              'ref.width': parsedStats.w,
              'ref.height': parsedStats.h,
              'ref.mime': parsedStats.mime
            });
            return parsedStats;
          }
          throw new Error('Failed to compute reference image statistics');
        });
        
        // Cache the stats
        referenceStatsCache.set(cacheKey, stats);
      }
      
      // Store reference image
      referenceImage = {
        path: resolvedPath,
        stats,
        fileHash,
        size: fileStats.size,
        mtime: fileStats.mtime.getTime(),
      };
      
      addSpanEvent('ref.loaded', {
        'ref.basename': path.basename(resolvedPath),
        'ref.cached': referenceStatsCache.has(cacheKey)
      });
      
      // Send confirmation
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { 
          type: 'text', 
          text: `Reference image loaded: ${path.basename(resolvedPath)} (${stats.w}×${stats.h})` 
        },
      });
      
      logger.line('info', { 
        ref_loaded: true, 
        path: path.basename(resolvedPath),
        dimensions: `${stats.w}×${stats.h}`,
        cached: referenceStatsCache.has(cacheKey)
      });
    } else {
      throw new Error('Usage: :ref open <path> | :ref clear');
    }
  });
}

async function handleEditCommand(command: string, sessionId: string): Promise<void> {
  logger.line('info', { handleEditCommand_called: true, command });

  // Check if we have an image loaded
  if (!lastLoadedImage) {
    throw new Error('No image loaded. Please load an image first.');
  }

  const stackManager = imageStacks.get(lastLoadedImage);
  if (!stackManager) {
    throw new Error('No edit stack for current image');
  }

  const client = mcpClients.get('image');
  if (!client) {
    throw new Error('No MCP image server available');
  }

  // Parse command
  if (command === ':undo') {
    if (!stackManager.undo()) {
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Nothing to undo' },
      });
      return;
    }
  } else if (command === ':redo') {
    if (!stackManager.redo()) {
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Nothing to redo' },
      });
      return;
    }
  } else if (command === ':reset') {
    stackManager.reset();
  } else if (command.startsWith(':crop')) {
    // Parse crop arguments
    const args = command.substring(5).trim();
    const cropOptions: any = {};

    // Parse --aspect
    const aspectMatch = args.match(/--aspect\s+(\S+)/);
    if (aspectMatch) {
      cropOptions.aspect = aspectMatch[1];
    }

    // Parse --rect
    const rectMatch = args.match(/--rect\s+([\d.,]+)/);
    if (rectMatch) {
      const coords = rectMatch[1].split(',').map(parseFloat);
      if (coords.length === 4) {
        cropOptions.rectNorm = coords as [number, number, number, number];
      }
    }

    // Parse --angle
    const angleMatch = args.match(/--angle\s+([-\d.]+)/);
    if (angleMatch) {
      cropOptions.angleDeg = parseFloat(angleMatch[1]);
    }

    // Parse --new-op flag
    const forceNew = args.includes('--new-op');
    cropOptions.forceNew = forceNew;

    // If aspect but no rect, we need to get image dimensions
    if (cropOptions.aspect && !cropOptions.rectNorm) {
      // Call read_image_meta to get dimensions
      const metaResult = await client.callTool({
        name: 'read_image_meta',
        arguments: { uri: lastLoadedImage },
      });

      // Parse dimensions from meta text
      const content = metaResult.content as any[] | undefined;
      const metaText = content?.[0]?.text || '';
      const dimMatch = metaText.match(/(\d+)×(\d+)/);
      if (dimMatch) {
        const width = parseInt(dimMatch[1]);
        const height = parseInt(dimMatch[2]);
        const rect = stackManager.computeAspectRect(width, height, cropOptions.aspect);
        if (rect) {
          cropOptions.rectNorm = rect;
        }
      }
    }

    // Add crop operation to stack
    stackManager.addCrop(cropOptions);
  } else if (command.startsWith(':wb')) {
    // Parse white balance arguments
    const args = command.substring(3).trim();
    const wbOptions: any = {};

    // Parse --gray point
    const grayMatch = args.match(/--gray\s+([\d.,]+)/);
    if (grayMatch) {
      const coords = grayMatch[1].split(',').map(parseFloat);
      if (coords.length === 2) {
        wbOptions.method = 'gray_point';
        wbOptions.x = coords[0];
        wbOptions.y = coords[1];
      }
    }

    // Parse --temp and --tint
    const tempMatch = args.match(/--temp\s+([-\d]+)/);
    const tintMatch = args.match(/--tint\s+([-\d]+)/);
    if (tempMatch || tintMatch) {
      wbOptions.method = 'temp_tint';
      if (tempMatch) wbOptions.temp = parseInt(tempMatch[1]);
      if (tintMatch) wbOptions.tint = parseInt(tintMatch[1]);
    }

    // Parse --new-op flag
    wbOptions.forceNew = args.includes('--new-op');

    if (!wbOptions.method) {
      throw new Error('White balance requires either --gray x,y or --temp/--tint');
    }

    // Add white balance operation to stack
    stackManager.addWhiteBalance(wbOptions);
  } else if (command.startsWith(':exposure')) {
    // Parse exposure arguments
    const args = command.substring(9).trim();
    const expOptions: any = {};

    // Parse --ev
    const evMatch = args.match(/--ev\s+([-\d.]+)/);
    if (evMatch) {
      expOptions.ev = parseFloat(evMatch[1]);
    } else {
      throw new Error('Exposure requires --ev value');
    }

    // Parse --new-op flag
    expOptions.forceNew = args.includes('--new-op');

    // Add exposure operation to stack
    stackManager.addExposure(expOptions);
  } else if (command.startsWith(':contrast')) {
    // Parse contrast arguments
    const args = command.substring(9).trim();
    const conOptions: any = {};

    // Parse --amt
    const amtMatch = args.match(/--amt\s+([-\d]+)/);
    if (amtMatch) {
      conOptions.amt = parseInt(amtMatch[1]);
    } else {
      throw new Error('Contrast requires --amt value');
    }

    // Parse --new-op flag
    conOptions.forceNew = args.includes('--new-op');

    // Add contrast operation to stack
    stackManager.addContrast(conOptions);
  } else if (command.startsWith(':saturation')) {
    // Parse saturation arguments
    const args = command.substring(11).trim();
    const satOptions: any = {};

    // Parse --amt
    const amtMatch = args.match(/--amt\s+([-\d]+)/);
    if (amtMatch) {
      satOptions.amt = parseInt(amtMatch[1]);
    } else {
      throw new Error('Saturation requires --amt value');
    }

    // Parse --new-op flag
    satOptions.forceNew = args.includes('--new-op');

    // Add saturation operation to stack
    stackManager.addSaturation(satOptions);
  } else if (command.startsWith(':vibrance')) {
    // Parse vibrance arguments
    const args = command.substring(9).trim();
    const vibOptions: any = {};

    // Parse --amt
    const amtMatch = args.match(/--amt\s+([-\d]+)/);
    if (amtMatch) {
      vibOptions.amt = parseInt(amtMatch[1]);
    } else {
      throw new Error('Vibrance requires --amt value');
    }

    // Parse --new-op flag
    vibOptions.forceNew = args.includes('--new-op');

    // Add vibrance operation to stack
    stackManager.addVibrance(vibOptions);
  } else if (command.startsWith(':auto')) {
    // Parse auto adjustment arguments
    const args = command.substring(5).trim();

    // Import auto adjust functions
    const { autoWhiteBalance, autoExposure, autoContrast, autoAll } = await import('../src/autoAdjust.js');

    if (args === 'wb') {
      // Auto white balance
      const wbOp = await autoWhiteBalance(lastLoadedImage.replace('file://', ''));
      stackManager.addWhiteBalance({
        method: wbOp.method,
        temp: wbOp.temp,
        tint: wbOp.tint,
        forceNew: false,
      });
    } else if (args === 'ev') {
      // Auto exposure
      const currentStack = stackManager.getStack();
      const wbOp = currentStack.ops.find((op) => op.op === 'white_balance') as any;
      const evOp = await autoExposure(lastLoadedImage.replace('file://', ''), wbOp);
      stackManager.addExposure({
        ev: evOp.ev,
        forceNew: false,
      });
    } else if (args === 'contrast') {
      // Auto contrast
      const currentStack = stackManager.getStack();
      const wbOp = currentStack.ops.find((op) => op.op === 'white_balance') as any;
      const evOp = currentStack.ops.find((op) => op.op === 'exposure') as any;
      const contrastOp = await autoContrast(lastLoadedImage.replace('file://', ''), wbOp, evOp);
      stackManager.addContrast({
        amt: contrastOp.amt,
        forceNew: false,
      });
    } else if (args === 'all') {
      // Auto all adjustments
      const adjustments = await autoAll(lastLoadedImage.replace('file://', ''));

      // Apply white balance
      stackManager.addWhiteBalance({
        method: adjustments.whiteBalance.method,
        temp: adjustments.whiteBalance.temp,
        tint: adjustments.whiteBalance.tint,
        forceNew: false,
      });

      // Apply exposure
      stackManager.addExposure({
        ev: adjustments.exposure.ev,
        forceNew: false,
      });

      // Apply contrast
      stackManager.addContrast({
        amt: adjustments.contrast.amt,
        forceNew: false,
      });
    } else {
      throw new Error('Auto requires: wb, ev, contrast, or all');
    }
  } else if (command === ':hist') {
    // Compute and display histogram
    logger.line('info', { hist_command_recognized: true });
    const editStack = stackManager.getStack();

    // Call compute_histogram tool
    const histResult = await client.callTool({
      name: 'compute_histogram',
      arguments: {
        uri: lastLoadedImage,
        editStack,
        bins: 64,
      },
    });

    // Parse histogram data
    const content = histResult.content as any[] | undefined;
    const histDataText = content?.[0]?.text || '{}';
    const histData = JSON.parse(histDataText);

    // Format and display histogram
    const { formatHistogramDisplay } = await import('../src/histogram.js');
    const histDisplay = formatHistogramDisplay(histData);

    // Send histogram display as text
    notify('session/update', {
      sessionId,
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: histDisplay },
    });

    return; // Don't render preview for histogram command
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  // Render preview with current stack
  const toolCallId = 'edit_preview';

  // Start tool call
  notify('session/update', {
    sessionId,
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'in_progress',
    rawInput: { command },
  });

  try {
    // Get current stack
    const editStack = stackManager.getStack();

    // Call render_preview
    const previewResult = await client.callTool({
      name: 'render_preview',
      arguments: {
        uri: lastLoadedImage,
        editStack,
        maxPx: 1024,
        format: 'jpeg',
        quality: 80,
      },
    });

    // Send stack info
    const stackInfo = `Stack: ${stackManager.getStackSummary()}`;
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: stackInfo },
        },
      ],
    });

    // Find image content
    const imageContent = Array.isArray(previewResult.content)
      ? previewResult.content.find((c: any) => c.type === 'image')
      : null;

    if (imageContent) {
      // Send preview image
      notify('session/update', {
        sessionId,
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'in_progress',
        content: [
          {
            type: 'content',
            content: {
              type: 'image',
              data: imageContent.data,
              mimeType: imageContent.mimeType,
            },
          },
        ],
      });
    }

    // Mark as completed
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
    });
  } catch (error: any) {
    logger.line('error', {
      edit_preview_failed: error.message,
    });

    // Send error update
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: `Failed to render preview: ${error.message}`,
          },
        },
      ],
    });
  }
}

async function handleExportCommand(command: string, sessionId: string, cwd: string, requestId: number): Promise<void> {
  // Check if we have an image loaded
  if (!lastLoadedImage) {
    throw new Error('No image loaded. Please load an image first.');
  }

  const stackManager = imageStacks.get(lastLoadedImage);
  if (!stackManager) {
    throw new Error('No edit stack for current image');
  }

  const client = mcpClients.get('image');
  if (!client) {
    throw new Error('No MCP image server available');
  }

  // Parse export arguments
  const args = command.substring(7).trim();
  const exportOptions: any = {
    format: 'jpeg',
    quality: 90,
    chromaSubsampling: '4:2:0',
    stripExif: true,
    colorProfile: 'srgb',
    overwrite: false,
  };

  // Parse --format
  const formatMatch = args.match(/--format\s+(\S+)/);
  if (formatMatch) {
    exportOptions.format = formatMatch[1];
  }

  // Parse --quality
  const qualityMatch = args.match(/--quality\s+(\d+)/);
  if (qualityMatch) {
    exportOptions.quality = parseInt(qualityMatch[1]);
  }

  // Parse --dst
  let dstPath: string;
  const dstMatch = args.match(/--dst\s+(\S+)/);
  if (dstMatch) {
    dstPath = path.resolve(cwd, dstMatch[1]);
  } else {
    // Default to ./Export/<orig>_edit.<ext>
    const origName = path.basename(lastLoadedImage, path.extname(lastLoadedImage));
    const ext = exportOptions.format === 'png' ? '.png' : '.jpg';
    dstPath = path.resolve(cwd, 'Export', `${origName}_edit${ext}`);
  }

  // Parse --overwrite flag
  exportOptions.overwrite = args.includes('--overwrite');

  // Parse --batch flag
  const isBatch = args.includes('--batch');

  if (isBatch) {
    // For batch, export all loaded images
    const allImages = Array.from(imageStacks.keys());
    if (allImages.length === 0) {
      throw new Error('No images loaded for batch export');
    }

    // TODO: Implement batch export
    throw new Error('Batch export not yet implemented');
  }

  // Get current edit stack
  const editStack = stackManager.getStack();

  // Estimate file size (rough approximation)
  const bytesApprox = 2500000; // ~2.5MB estimate for edited image
  const sidecarBytesApprox = JSON.stringify(editStack).length + 100;

  // Build permission operations
  const operations: PermissionOperation[] = [
    {
      kind: 'write_file',
      uri: pathToFileURL(dstPath).href,
      bytesApprox,
    },
    {
      kind: 'write_file',
      uri: pathToFileURL(dstPath + '.editstack.json').href,
      bytesApprox: sidecarBytesApprox,
    },
  ];

  // Send permission request
  const permId = requestId + 1000; // Use offset to avoid ID collision
  const permissionRequest = {
    jsonrpc: '2.0',
    id: permId,
    method: 'session/request_permission',
    params: {
      sessionId,
      title: 'Export edited image',
      explanation: `Write edited image and edit stack to ${path.basename(dstPath)}`,
      operations,
    },
  };

  // Create promise to wait for permission response
  const granted = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPermissions.delete(permId);
      logger.line('info', { permission_timeout: permId });
      resolve(false); // Auto-deny on timeout
    }, 15000); // 15 second timeout

    pendingPermissions.set(permId, { resolve, reject, timeout });
    send(permissionRequest);
  });

  if (!granted) {
    throw new Error('Export cancelled: Permission denied by client');
  }

  // Start export with progress updates - use unique ID
  const toolCallId = `export_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  // Send initial progress
  notify('session/update', {
    sessionId,
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'in_progress',
    rawInput: { command, dst: dstPath },
  });

  // Send text update about rendering
  notify('session/update', {
    sessionId,
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'in_progress',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: 'Rendering full resolution...' },
      },
    ],
  });

  try {
    // Call commit_version
    const commitResult = await client.callTool({
      name: 'commit_version',
      arguments: {
        uri: lastLoadedImage,
        editStack,
        dstUri: pathToFileURL(dstPath).href,
        format: exportOptions.format,
        quality: exportOptions.quality,
        chromaSubsampling: exportOptions.chromaSubsampling,
        stripExif: exportOptions.stripExif,
        colorProfile: exportOptions.colorProfile,
        overwrite: exportOptions.overwrite,
      },
    });

    // Parse result
    const content = commitResult.content as any[] | undefined;
    const resultData = JSON.parse(content?.[0]?.text || '{}');

    // Write sidecar file
    const sidecarPath = dstPath + '.editstack.json';
    const sidecarContent = {
      version: 1,
      baseUri: lastLoadedImage,
      ops: editStack.ops,
      createdAt: new Date().toISOString(),
      render: {
        format: exportOptions.format,
        quality: exportOptions.quality,
        colorProfile: exportOptions.colorProfile,
      },
    };

    try {
      await fs.writeFile(sidecarPath, JSON.stringify(sidecarContent, null, 2));
    } catch (err: any) {
      logger.line('error', { sidecar_write_failed: err.message });
    }

    // Send success summary
    const sizeKB = Math.round(resultData.bytes / 1024);
    const sizeMB = resultData.bytes / (1024 * 1024);
    const summary = `Exported: ${path.basename(dstPath)} (${resultData.width}×${resultData.height}, ${sizeKB}KB, ${resultData.format})`;

    // Warn if file is large
    if (sizeMB > 10) {
      logger.line('info', { large_export_warning: `Exported file is ${sizeMB.toFixed(1)}MB` });
    }

    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: summary },
        },
      ],
    });

    // Mark as completed
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
    });

    // Log export
    logger.line('info', {
      export_success: true,
      src: lastLoadedImage,
      dst: dstPath,
      stackHash: stackManager.computeHash(),
      elapsedMs: resultData.elapsedMs,
      bytes: resultData.bytes,
      success: true,
    });
  } catch (error: any) {
    logger.line('error', {
      export_failed: error.message,
    });

    // Send error update
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: `Export failed: ${error.message}`,
          },
        },
      ],
    });

    // Log failed export
    logger.line('error', {
      export_success: false,
      src: lastLoadedImage,
      dst: dstPath,
      stackHash: stackManager.computeHash(),
      error: error.message,
      success: false,
    });

    throw error;
  }
}

// Transport manages process lifecycle - no manual cleanup needed

// Cleanup handlers for graceful shutdown
process.on('SIGINT', async () => {
  logger.line('info', { event: 'shutdown', signal: 'SIGINT' });

  // Close all MCP clients
  for (const [name, client] of mcpClients) {
    try {
      await client.close();
      logger.line('info', { event: 'mcp_client_closed', name });
    } catch (e) {
      logger.line('error', { event: 'mcp_client_close_failed', name, error: e });
    }
  }

  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.line('info', { event: 'shutdown', signal: 'SIGTERM' });

  // Close all MCP clients
  for (const [name, client] of mcpClients) {
    try {
      await client.close();
      logger.line('info', { event: 'mcp_client_closed', name });
    } catch (e) {
      logger.line('error', { event: 'mcp_client_close_failed', name, error: e });
    }
  }

  process.exit(0);
});
