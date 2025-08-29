#!/usr/bin/env node
import { createNdjsonReader } from '../src/common/ndjson';
import { NdjsonLogger } from '../src/common/logger';
import { Readable } from 'stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import { MCPServerConfig, ContentBlock, ToolCallContent } from '../src/acp/types';
import path from 'path';

const logger = new NdjsonLogger('agent');

type Req = { id:number, method:string, params:any };
let currentSessionId: string | null = null;
let cancelled = false;
let mcpClients: Map<string, Client> = new Map();
let mcpProcesses: Map<string, ChildProcess> = new Map();

// Read stdin as NDJSON
createNdjsonReader(process.stdin as unknown as Readable, (obj:any) => {
  logger.line('recv', obj);
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
        },
        (err) => {
          logger.line('error', { mcp_connection_failed: err.message });
        }
      );
    }
    
    send({ jsonrpc: '2.0', id, result: { sessionId: currentSessionId } });
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
      const env: Record<string, string> = Object.fromEntries(
        Object.entries({ ...process.env, ...server.env })
          .filter(([_, v]) => v !== undefined) as [string, string][]
      );
      
      // Spawn the MCP server process
      const serverProcess = spawn(server.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env
      });
      
      // Create transport and client
      const transport = new StdioClientTransport({
        command: server.command,
        args,
        env: env as any
      });
      
      const client = new Client({
        name: `photo-agent-${server.name}`,
        version: '0.1.0'
      }, {
        capabilities: {}
      });
      
      // Connect the client
      await client.connect(transport);
      
      // Store the client and process
      mcpClients.set(server.name, client);
      mcpProcesses.set(server.name, serverProcess);
      
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
      
      if (metaResult.content && Array.isArray(metaResult.content) && metaResult.content.length > 0) {
        const metaText = metaResult.content[0].type === 'text' 
          ? metaResult.content[0].text 
          : '';
        
        const metadata = JSON.parse(metaText);
        const displayText = `${link.name || path.basename(link.uri)} ${metadata.width}×${metadata.height}, ${(metadata.sizeBytes / 1024 / 1024).toFixed(1)}MB, ${metadata.mime}`;
        
        // Send metadata update
        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: [{
            type: 'content',
            content: { type: 'text', text: displayText }
          }]
        });
      }
      
      // Call render_thumbnail
      const thumbResult = await client.callTool({
        name: 'render_thumbnail',
        arguments: { uri: link.uri, maxPx: 1024 }
      });
      
      if (thumbResult.content && Array.isArray(thumbResult.content) && thumbResult.content.length > 0) {
        const thumbText = thumbResult.content[0].type === 'text' 
          ? thumbResult.content[0].text 
          : '';
        
        const thumbData = JSON.parse(thumbText);
        
        // Send thumbnail update
        notify('session/update', {
          sessionId,
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: [{
            type: 'content',
            content: { 
              type: 'image', 
              data: thumbData.image,
              mimeType: thumbData.mime
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

// Cleanup on exit
process.on('exit', () => {
  for (const [name, proc] of mcpProcesses) {
    proc.kill();
  }
});