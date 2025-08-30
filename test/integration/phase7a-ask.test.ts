import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { JsonRpcPeer } from '../../src/common/jsonrpc';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';

describe('Phase 7a - :ask Command Integration Tests', () => {
  let agentProc: any;
  let peer: JsonRpcPeer;
  let sessionId: string;
  const testImagePath = path.join(process.cwd(), 'test', 'assets', 'test.jpg');
  const testImageUri = pathToFileURL(testImagePath).href;

  beforeAll(async () => {
    // Spawn agent process
    agentProc = spawn('node', ['dist/cmd/photo-agent.js'], {
      stdio: ['pipe', 'pipe', 'inherit']
    });
    
    peer = new JsonRpcPeer(agentProc.stdout, agentProc.stdin, null as any);
    
    // Initialize
    const initRes = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    });
    expect(initRes.protocolVersion).toBe(1);
    
    // Create session with mock planner enabled
    const newRes = await peer.request('session/new', {
      cwd: process.cwd(),
      planner: 'mock',
      mcpServers: [{
        name: 'image',
        command: 'node',
        args: [path.join(process.cwd(), 'dist/cmd/mcp-image-server.js')],
        env: {}
      }]
    });
    sessionId = newRes.sessionId;
    
    // Wait for MCP server connection
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Load test image
    const loadRes = await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'resource_link', uri: testImageUri }]
    });
    expect(loadRes.stopReason).toBe('end_turn');
  });

  afterAll(async () => {
    if (agentProc) {
      agentProc.kill();
    }
  });

  it('should handle basic :ask command with multiple operations', async () => {
    const updates: any[] = [];
    peer.on('session/update', (params) => updates.push(params));
    
    const result = await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: ':ask warmer, +0.5 ev, more contrast, crop square' }]
    });
    
    expect(result.stopReason).toBe('end_turn');
    
    // Check for text summary update
    const textUpdate = updates.find(u => 
      u.sessionUpdate === 'agent_message_chunk' && 
      u.content?.type === 'text'
    );
    expect(textUpdate).toBeDefined();
    expect(textUpdate.content.text).toContain('Applied:');
    expect(textUpdate.content.text).toContain('WB(temp +20');
    expect(textUpdate.content.text).toContain('EV +0.50');
    expect(textUpdate.content.text).toContain('Contrast +20');
    expect(textUpdate.content.text).toContain('Crop 1:1');
    expect(textUpdate.content.text).toContain('Stack:');
    
    // Check for image preview update
    const imageUpdate = updates.find(u => 
      u.sessionUpdate === 'tool_call_update' && 
      u.content?.[0]?.type === 'image'
    );
    expect(imageUpdate).toBeDefined();
  });

  it('should handle clamping and report clamped values', async () => {
    const updates: any[] = [];
    peer.on('session/update', (params) => updates.push(params));
    
    const result = await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: ':ask cool by 200, ev 10, contrast 150' }]
    });
    
    expect(result.stopReason).toBe('end_turn');
    
    const textUpdate = updates.find(u => 
      u.sessionUpdate === 'agent_message_chunk' && 
      u.content?.type === 'text'
    );
    expect(textUpdate).toBeDefined();
    expect(textUpdate.content.text).toContain('Clamped:');
    expect(textUpdate.content.text).toContain('temp -200 → -100');
    expect(textUpdate.content.text).toContain('ev 10.0 → 3.0');
    expect(textUpdate.content.text).toContain('contrast 150 → 100');
  });

  it('should handle amend-last behavior', async () => {
    const updates: any[] = [];
    peer.on('session/update', (params) => updates.push(params));
    
    // First, reset the stack
    await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: ':reset' }]
    });
    
    // Apply two contrast adjustments - should amend to single op
    const result = await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: ':ask contrast 35, contrast 10' }]
    });
    
    expect(result.stopReason).toBe('end_turn');
    
    const textUpdate = updates.find(u => 
      u.sessionUpdate === 'agent_message_chunk' && 
      u.content?.type === 'text'
    );
    expect(textUpdate).toBeDefined();
    expect(textUpdate.content.text).toContain('Stack: Contrast +45');
  });

  it('should handle undo/redo/reset commands', async () => {
    const updates: any[] = [];
    peer.on('session/update', (params) => updates.push(params));
    
    const result = await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: ':ask undo undo redo reset' }]
    });
    
    expect(result.stopReason).toBe('end_turn');
    
    const textUpdate = updates.find(u => 
      u.sessionUpdate === 'agent_message_chunk' && 
      u.content?.type === 'text'
    );
    expect(textUpdate).toBeDefined();
    expect(textUpdate.content.text).toContain('Applied: Undo, Undo, Redo, Reset');
    expect(textUpdate.content.text).toContain('Stack: No operations');
  });

  it('should report ignored terms', async () => {
    const updates: any[] = [];
    peer.on('session/update', (params) => updates.push(params));
    
    const result = await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: ':ask warmer, foo, bar, contrast 10' }]
    });
    
    expect(result.stopReason).toBe('end_turn');
    
    const textUpdate = updates.find(u => 
      u.sessionUpdate === 'agent_message_chunk' && 
      u.content?.type === 'text'
    );
    expect(textUpdate).toBeDefined();
    expect(textUpdate.content.text).toContain('Ignored terms: foo, bar');
  });

  it('should handle planner disabled mode', async () => {
    // Create new session with planner disabled
    const newRes = await peer.request('session/new', {
      cwd: process.cwd(),
      planner: 'off',
      mcpServers: [{
        name: 'image',
        command: 'node',
        args: [path.join(process.cwd(), 'dist/cmd/mcp-image-server.js')],
        env: {}
      }]
    });
    const offSessionId = newRes.sessionId;
    
    // Load image first
    await peer.request('session/prompt', {
      sessionId: offSessionId,
      prompt: [{ type: 'resource_link', uri: testImageUri }]
    });
    
    const updates: any[] = [];
    peer.on('session/update', (params) => updates.push(params));
    
    const result = await peer.request('session/prompt', {
      sessionId: offSessionId,
      prompt: [{ type: 'text', text: ':ask warmer' }]
    });
    
    expect(result.stopReason).toBe('end_turn');
    
    const textUpdate = updates.find(u => 
      u.sessionUpdate === 'agent_message_chunk' && 
      u.content?.type === 'text'
    );
    expect(textUpdate).toBeDefined();
    expect(textUpdate.content.text).toContain('Planner disabled');
  });

  it('should error when no image is loaded', async () => {
    // Create fresh session
    const newRes = await peer.request('session/new', {
      cwd: process.cwd(),
      planner: 'mock',
      mcpServers: [{
        name: 'image',
        command: 'node',
        args: [path.join(process.cwd(), 'dist/cmd/mcp-image-server.js')],
        env: {}
      }]
    });
    const noImageSessionId = newRes.sessionId;
    
    const updates: any[] = [];
    peer.on('session/update', (params) => updates.push(params));
    
    const result = await peer.request('session/prompt', {
      sessionId: noImageSessionId,
      prompt: [{ type: 'text', text: ':ask warmer' }]
    });
    
    expect(result.stopReason).toBe('end_turn');
    
    const textUpdate = updates.find(u => 
      u.sessionUpdate === 'agent_message_chunk' && 
      u.content?.type === 'text'
    );
    expect(textUpdate).toBeDefined();
    expect(textUpdate.content.text).toContain('Error');
    expect(textUpdate.content.text).toContain('No image loaded');
  });
});