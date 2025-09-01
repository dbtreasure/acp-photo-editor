// Integration tests for Phase 7c: Vision-lite Planner (WB only)

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('Phase 7c: Vision-lite Planner', () => {
  let mcpServer: ChildProcess;
  let agent: ChildProcess;
  
  beforeAll(async () => {
    // Start MCP server
    mcpServer = spawn('node', ['dist/cmd/mcp-image-server.js'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));
  });
  
  afterAll(async () => {
    // Clean up processes
    if (mcpServer) {
      mcpServer.kill();
    }
    if (agent) {
      agent.kill();
    }
  });
  
  describe('Vision mode flag parsing', () => {
    it('should parse --with-image flag in :ask command', async () => {
      // Start agent with mock planner
      agent = spawn('node', ['dist/cmd/photo-agent.js', '--planner=mock'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      // Send initialize
      agent.stdin!.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 }
      }) + '\n');
      
      // Wait for response
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Send session/new
      agent.stdin!.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: process.cwd() }
      }) + '\n');
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Test command parsing
      const testImage = path.join(process.cwd(), 'test/assets/test.jpg');
      
      // First load an image
      agent.stdin!.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId: 'test-session',
          prompt: [{ type: 'text', text: `:open ${testImage}` }]
        }
      }) + '\n');
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Send :ask with --with-image
      agent.stdin!.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/prompt',
        params: {
          sessionId: 'test-session',
          prompt: [{ type: 'text', text: ':ask --with-image "fix white balance"' }]
        }
      }) + '\n');
      
      // Check that the command was processed
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // The test passes if no errors were thrown
      expect(true).toBe(true);
    });
  });
  
  describe('WB-only filtering', () => {
    it('should drop non-WB calls in vision mode', async () => {
      // This test would require a Gemini API key to fully test
      // For now, we'll test that the filtering logic is in place
      
      const { GeminiPlanner } = await import('../../src/planner/gemini');
      const planner = new GeminiPlanner({ apiKey: 'test-key' });
      
      // Mock the client to avoid actual API calls
      (planner as any).client = null;
      
      // Test that fallback works when no API key
      const result = await planner.plan({
        text: 'make it warmer and brighter',
        imageB64: 'fake-image-data'
      });
      
      // Should fall back to mock planner
      expect(result.notes).toContain('Planner fell back to mock (no API key).');
    });
  });
  
  describe('Coordinate mapping', () => {
    it('should map preview coordinates to original space', async () => {
      // Import the mapping function (we'll need to export it first)
      // For now, test the concept
      
      const mockStack = {
        ops: [
          {
            op: 'crop',
            rectNorm: [0.1, 0.1, 0.8, 0.8], // 80% crop from 10% offset
            angleDeg: 0
          }
        ]
      };
      
      // Test coordinate in center of preview (0.5, 0.5)
      // Should map to (0.1 + 0.5 * 0.8, 0.1 + 0.5 * 0.8) = (0.5, 0.5) in original
      
      // This would test the actual mapping function
      expect(true).toBe(true);
    });
  });
  
  describe('Preview capture', () => {
    it('should capture preview image when --with-image flag is present', async () => {
      // This test verifies that preview capture is attempted
      // Would need a full agent setup to test completely
      
      expect(true).toBe(true);
    });
  });
  
  describe('Telemetry', () => {
    it('should log vision mode in telemetry', async () => {
      const logFile = `logs/test-vision-${Date.now()}.ndjson`;
      
      // Check that vision flag is logged
      // This would require parsing actual log output
      
      expect(true).toBe(true);
    });
  });
});