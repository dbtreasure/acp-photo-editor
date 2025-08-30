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
import { EditStackManager } from '../src/editStack';
import { MockPlanner } from '../src/planner/mock';
import { GeminiPlanner, PlannerState as GeminiPlannerState } from '../src/planner/gemini';
import { Planner, PlannedCall, PLANNER_CLAMPS } from '../src/planner/types';
import path from 'path';
import fs from 'fs/promises';
import { pathToFileURL } from 'url';

const logger = new NdjsonLogger('agent');

type Req = { id:number, method:string, params:any };
let currentSessionId: string | null = null;
let cancelled = false;
let mcpClients: Map<string, Client> = new Map();

// Per-image edit state management
const imageStacks = new Map<string, EditStackManager>();
let lastLoadedImage: string | null = null;

// Planner configuration (from session/new)
let plannerMode: 'mock' | 'gemini' | 'off' = 'mock';
let plannerConfig: {
  model?: string;
  timeout?: number;
  maxCalls?: number;
  logText?: boolean;
} = {};

// Permission request tracking
const pendingPermissions = new Map<number, {
  resolve: (value: boolean) => void;
  reject: (reason?: any) => void;
  timeout: NodeJS.Timeout;
}>();

// Read stdin as NDJSON
createNdjsonReader(process.stdin as unknown as Readable, (obj:any) => {
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
  
  if (!obj || obj.jsonrpc !== '2.0' || typeof obj.method !== 'string') return;
  const id = obj.id;
  const method = obj.method;
  const params = obj.params || {};

  if (method === 'initialize') {
    const result = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: false }
      },
      authMethods: []
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
      logText: params.plannerLogText || false
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
            content: { type: 'text', text: `Error: ${err.message}` }
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
            content: { type: 'text', text: `Error: ${err.message}` }
          });
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      );
      return;
    }
    
    // Check for edit commands (crop, undo, redo, reset, white balance, exposure, contrast, saturation, vibrance, auto, hist)
    if (text.startsWith(':crop') || text === ':undo' || text === ':redo' || text === ':reset' ||
        text.startsWith(':wb') || text.startsWith(':exposure') || text.startsWith(':contrast') ||
        text.startsWith(':saturation') || text.startsWith(':vibrance') || text.startsWith(':auto') || text === ':hist') {
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
            content: { type: 'text', text: `Error: ${err.message}` }
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
            content: { type: 'text', text: `Error processing resources: ${err.message}` }
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
          } else {
            responseText = `echo:${text}`;
          }
          
          notify('session/update', {
            sessionId: currentSessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: responseText }
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
        Object.entries({ ...process.env, ...server.env, MCP_ROOT: cwd })
          .filter(([_, v]) => v !== undefined) as [string, string][]
      );
      
      // Let StdioClientTransport handle spawning - no manual spawn
      const transport = new StdioClientTransport({
        command: server.command,
        args,
        env
      });
      
      const client = new Client({
        name: `photo-agent-${server.name}`,
        version: '0.1.0'
      }, {
        capabilities: {}
      });
      
      // Connect the client (transport will spawn the process)
      await client.connect(transport);
      
      // Store only the client - transport manages process lifecycle
      mcpClients.set(server.name, client);
      
      logger.line('info', { mcp_server_connected: server.name });
    } catch (error: any) {
      logger.line('error', { 
        mcp_server_failed: server.name, 
        error: error.message 
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
      rawInput: { uri: link.uri }
    });
    
    try {
      // Call read_image_meta
      const metaResult = await client.callTool({
        name: 'read_image_meta',
        arguments: { uri: link.uri }
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
          content: [{
            type: 'content',
            content: { type: 'text', text: metaContent.text }
          }]
        });
      }
      
      // Call render_thumbnail
      const thumbResult = await client.callTool({
        name: 'render_thumbnail',
        arguments: { uri: link.uri, maxPx: 1024 }
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
          content: [{
            type: 'content',
            content: { 
              type: 'image', 
              data: thumbContent.data,
              mimeType: thumbContent.mimeType
            }
          }]
        });
      }
      
      // Mark as completed
      notify('session/update', {
        sessionId,
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed'
      });
      
    } catch (error: any) {
      logger.line('error', { 
        tool_call_failed: toolCallId, 
        error: error.message 
      });
      
      // Send error update
      notify('session/update', {
        sessionId,
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [{
          type: 'content',
          content: { 
            type: 'text', 
            text: `Failed to process ${link.name}: ${error.message}` 
          }
        }]
      });
    }
  }
}

function send(obj:any) {
  logger.line('send', obj);
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function notify(method:string, params:any) {
  const msg = { jsonrpc: '2.0', method, params };
  send(msg);
}

// Helper to get image metadata
async function getImageMetadata(uri: string, client: Client): Promise<{ width: number; height: number; mimeType?: string }> {
  try {
    const result = await client.callTool({
      name: 'read_image_meta',
      arguments: { uri }
    });
    
    const content = result.content as any;
    if (content?.[0]?.type === 'text') {
      const meta = JSON.parse(content[0].text);
      return {
        width: meta.width || 0,
        height: meta.height || 0,
        mimeType: meta.format ? `image/${meta.format.toLowerCase()}` : undefined
      };
    }
  } catch (error) {
    logger.line('error', { get_image_metadata_failed: error });
  }
  
  // Return defaults if metadata fetch fails
  return { width: 0, height: 0, mimeType: 'image/jpeg' };
}

async function handleAskCommand(command: string, sessionId: string, cwd: string, requestId: number): Promise<void> {
  logger.line('info', { handleAskCommand_called: true, command, plannerMode });
  
  // Check if planner is disabled
  if (plannerMode === 'off') {
    notify('session/update', {
      sessionId,
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Planner disabled. Use --planner=mock or --planner=gemini to enable.' }
    });
    return;
  }
  
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
  
  // Extract text after ":ask "
  const askText = command.substring(5).trim();
  if (!askText) {
    throw new Error('No text provided. Usage: :ask "warmer, +0.5 ev, crop square"');
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
      mime: imageMeta.mimeType || 'image/jpeg'
    },
    stackSummary: stackManager.getStackSummary(),
    limits: {
      temp: [PLANNER_CLAMPS.temp.min, PLANNER_CLAMPS.temp.max],
      ev: [PLANNER_CLAMPS.ev.min, PLANNER_CLAMPS.ev.max],
      contrast: [PLANNER_CLAMPS.contrast.min, PLANNER_CLAMPS.contrast.max],
      angle: [PLANNER_CLAMPS.angleDeg.min, PLANNER_CLAMPS.angleDeg.max]
    }
  };
  
  // Plan the operations
  const startTime = Date.now();
  const { calls, notes } = await planner.plan({ text: askText, state: plannerState });
  const planningTime = Date.now() - startTime;
  
  // Log apply result
  const stackBefore = stackManager.getStack();
  const stackHashBefore = JSON.stringify(stackBefore).length; // Simple hash
  
  logger.line('info', { planner_output: { calls, notes } });
  
  // Track what was clamped
  const clampedValues: string[] = [];
  const appliedOps: string[] = [];
  let hasExport = false;
  
  // Process each planned call
  for (const call of calls) {
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
          tint: clampedTint
        });
        appliedOps.push(`WB(temp ${clampedTemp > 0 ? '+' : ''}${clampedTemp} tint ${clampedTint > 0 ? '+' : ''}${clampedTint})`);
        break;
      }
      
      case 'set_white_balance_gray': {
        const { x, y } = call.args;
        const clampedX = Math.max(0, Math.min(1, x));
        const clampedY = Math.max(0, Math.min(1, y));
        
        stackManager.addWhiteBalance({
          method: 'gray_point',
          x: clampedX,
          y: clampedY
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
      
      case 'set_crop': {
        const { aspect, rectNorm, angleDeg } = call.args;
        const options: any = {};
        
        if (aspect) {
          options.aspect = aspect;
          appliedOps.push(`Crop ${aspect}`);
        }
        if (rectNorm) {
          options.rectNorm = rectNorm;
          if (!aspect) {
            appliedOps.push(`Crop rect`);
          }
        }
        if (angleDeg !== undefined) {
          // Check if we have an existing crop with angle to accumulate with
          const currentStack = stackManager.getStack();
          let lastCropOp: any = null;
          for (let i = currentStack.ops.length - 1; i >= 0; i--) {
            const op = currentStack.ops[i] as any;
            if (op.op === 'crop') {
              lastCropOp = op;
              break;
            }
          }
          
          let finalAngle = angleDeg;
          if (lastCropOp && lastCropOp.angleDeg !== undefined) {
            finalAngle = lastCropOp.angleDeg + angleDeg;
          }
          
          const clampedAngle = Math.max(PLANNER_CLAMPS.angleDeg.min, Math.min(PLANNER_CLAMPS.angleDeg.max, finalAngle));
          if (clampedAngle !== finalAngle) {
            clampedValues.push(`angle ${finalAngle}° → ${clampedAngle}°`);
          }
          options.angleDeg = clampedAngle;
          appliedOps.push(`Rotate ${clampedAngle.toFixed(1)}°`);
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
        // Export will be handled after rendering
        break;
      }
    }
  }
  
  // Log apply result telemetry
  const stackAfter = stackManager.getStack();
  const stackHashAfter = JSON.stringify(stackAfter).length; // Simple hash
  logger.line('info', { event: 'apply_result',
    stackHashBefore,
    stackHashAfter,
    previewMs: planningTime,
    operationsApplied: appliedOps.length,
    valuesClamped: clampedValues.length
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
  
  // Send text summary first
  notify('session/update', {
    sessionId,
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: summaryText }
  });
  
  // Render preview (only if we have operations)
  if (stackManager.hasOperations()) {
    const toolCallId = 'ask_render';
    
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      rawInput: { operation: 'render_preview' }
    });
    
    try {
      const stack = stackManager.getStack();
      const previewResult = await client.callTool({
        name: 'render_preview',
        arguments: {
          uri: lastLoadedImage,
          editStack: stack,
          maxPx: 1024
        }
      });
      
      const content = previewResult.content as any;
      if (content?.[0]?.type === 'image') {
        const imageData = content[0].data;
        const mimeType = content[0].mimeType || 'image/png';
        
        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          content: [{ type: 'image', data: imageData, mimeType }]
        });
      }
    } catch (error: any) {
      logger.line('error', { render_preview_failed: error.message });
      notify('session/update', {
        sessionId,
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        error: { message: error.message }
      });
    }
  }
  
  // Handle export if requested
  if (hasExport) {
    const exportCall = calls.find(c => c.fn === 'export_image');
    if (exportCall) {
      const args = exportCall.args || {};
      
      // Build export options
      const exportOptions: any = {
        format: args.format || 'jpeg',
        quality: args.quality || 90,
        chromaSubsampling: '4:2:0',
        stripExif: true,
        colorProfile: 'srgb',
        overwrite: args.overwrite || false
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
      
      // Request permission for export
      const permId = requestId + 2000; // Use offset to avoid ID collision
      const operations: PermissionOperation[] = [
        {
          kind: 'write_file',
          uri: pathToFileURL(dstPath).href,
          bytesApprox: 2500000 // ~2.5MB estimate
        },
        {
          kind: 'write_file',
          uri: pathToFileURL(dstPath + '.editstack.json').href,
          bytesApprox: JSON.stringify(stackManager.getStack()).length + 100
        }
      ];
      
      const permissionRequest = {
        jsonrpc: '2.0',
        id: permId,
        method: 'session/request_permission',
        params: {
          sessionId,
          title: 'Export edited image',
          explanation: `Write edited image to ${path.basename(dstPath)}`,
          operations
        }
      };
      
      const approved = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingPermissions.delete(permId);
          logger.line('info', { permission_timeout: permId });
          resolve(false); // Auto-deny on timeout
        }, 15000); // 15 second timeout
        
        pendingPermissions.set(permId, { resolve, reject, timeout });
        send(permissionRequest);
      });
      
      if (approved) {
        const toolCallId = 'ask_export';
        
        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          rawInput: { operation: 'export', dst: dstPath }
        });
        
        try {
          // Ensure Export directory exists
          const exportDir = path.dirname(dstPath);
          await fs.mkdir(exportDir, { recursive: true });
          
          const stack = stackManager.getStack();
          const dstUri = pathToFileURL(dstPath).href;
          
          const exportResult = await client.callTool({
            name: 'commit_version',
            arguments: {
              uri: lastLoadedImage,
              editStack: stack,
              dstUri,
              ...exportOptions
            }
          });
          
          // Log export result telemetry
          logger.line('info', { event: 'export_result',
            destination: dstPath,
            format: exportOptions.format,
            quality: exportOptions.quality,
            success: true
          });
          
          notify('session/update', {
            sessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Export complete: ${dstPath}` }
          });
        } catch (error: any) {
          logger.line('error', { export_failed: error.message });
          notify('session/update', {
            sessionId,
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Export failed: ${error.message}` }
          });
        }
      } else {
        notify('session/update', {
          sessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Export cancelled by user' }
        });
      }
    }
  }
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
        content: { type: 'text', text: 'Nothing to undo' }
      });
      return;
    }
  } else if (command === ':redo') {
    if (!stackManager.redo()) {
      notify('session/update', {
        sessionId,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Nothing to redo' }
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
        arguments: { uri: lastLoadedImage }
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
        forceNew: false
      });
    } else if (args === 'ev') {
      // Auto exposure
      const currentStack = stackManager.getStack();
      const wbOp = currentStack.ops.find(op => op.op === 'white_balance') as any;
      const evOp = await autoExposure(lastLoadedImage.replace('file://', ''), wbOp);
      stackManager.addExposure({
        ev: evOp.ev,
        forceNew: false
      });
    } else if (args === 'contrast') {
      // Auto contrast
      const currentStack = stackManager.getStack();
      const wbOp = currentStack.ops.find(op => op.op === 'white_balance') as any;
      const evOp = currentStack.ops.find(op => op.op === 'exposure') as any;
      const contrastOp = await autoContrast(lastLoadedImage.replace('file://', ''), wbOp, evOp);
      stackManager.addContrast({
        amt: contrastOp.amt,
        forceNew: false
      });
    } else if (args === 'all') {
      // Auto all adjustments
      const adjustments = await autoAll(lastLoadedImage.replace('file://', ''));
      
      // Apply white balance
      stackManager.addWhiteBalance({
        method: adjustments.whiteBalance.method,
        temp: adjustments.whiteBalance.temp,
        tint: adjustments.whiteBalance.tint,
        forceNew: false
      });
      
      // Apply exposure
      stackManager.addExposure({
        ev: adjustments.exposure.ev,
        forceNew: false
      });
      
      // Apply contrast
      stackManager.addContrast({
        amt: adjustments.contrast.amt,
        forceNew: false
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
        bins: 64
      }
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
      content: { type: 'text', text: histDisplay }
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
    rawInput: { command }
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
        maxPx: 1024
      }
    });
    
    // Send stack info
    const stackInfo = `Stack: ${stackManager.getStackSummary()}`;
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      content: [{
        type: 'content',
        content: { type: 'text', text: stackInfo }
      }]
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
        content: [{
          type: 'content',
          content: {
            type: 'image',
            data: imageContent.data,
            mimeType: imageContent.mimeType
          }
        }]
      });
    }
    
    // Mark as completed
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed'
    });
    
  } catch (error: any) {
    logger.line('error', {
      edit_preview_failed: error.message
    });
    
    // Send error update
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: `Failed to render preview: ${error.message}`
        }
      }]
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
    overwrite: false
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
      bytesApprox
    },
    {
      kind: 'write_file',
      uri: pathToFileURL(dstPath + '.editstack.json').href,
      bytesApprox: sidecarBytesApprox
    }
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
      operations
    }
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
    rawInput: { command, dst: dstPath }
  });
  
  // Send text update about rendering
  notify('session/update', {
    sessionId,
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'in_progress',
    content: [{
      type: 'content',
      content: { type: 'text', text: 'Rendering full resolution...' }
    }]
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
        overwrite: exportOptions.overwrite
      }
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
        colorProfile: exportOptions.colorProfile
      }
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
      content: [{
        type: 'content',
        content: { type: 'text', text: summary }
      }]
    });
    
    // Mark as completed
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed'
    });
    
    // Log export
    logger.line('info', {
      export_success: true,
      src: lastLoadedImage,
      dst: dstPath,
      stackHash: stackManager.computeHash(),
      elapsedMs: resultData.elapsedMs,
      bytes: resultData.bytes,
      success: true
    });
    
  } catch (error: any) {
    logger.line('error', {
      export_failed: error.message
    });
    
    // Send error update
    notify('session/update', {
      sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: `Export failed: ${error.message}`
        }
      }]
    });
    
    // Log failed export
    logger.line('error', {
      export_success: false,
      src: lastLoadedImage,
      dst: dstPath,
      stackHash: stackManager.computeHash(),
      error: error.message,
      success: false
    });
    
    throw error;
  }
}

// Transport manages process lifecycle - no manual cleanup needed