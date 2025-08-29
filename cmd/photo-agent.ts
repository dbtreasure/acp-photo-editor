#!/usr/bin/env node
import { createNdjsonReader } from '../src/common/ndjson';
import { NdjsonLogger } from '../src/common/logger';
import { Readable } from 'stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCPServerConfig, ContentBlock, ToolCallContent, PermissionOperation } from '../src/acp/types';
import { EditStackManager } from '../src/editStack';
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
    
    // Check for edit commands (crop, undo, redo, reset)
    if (text.startsWith(':crop') || text === ':undo' || text === ':redo' || text === ':reset') {
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

async function handleEditCommand(command: string, sessionId: string): Promise<void> {
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
    const stackInfo = `Stack: ${stackManager.getStackLength()} ops | Last: ${stackManager.getLastOpSummary()}`;
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