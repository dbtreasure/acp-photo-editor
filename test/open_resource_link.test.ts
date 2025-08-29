import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';

function runOpenDemo(): Promise<{ code: number, out: string[] }> {
  return new Promise((resolve) => {
    const client = path.resolve(__dirname, '../dist/cmd/photo-client.js');
    const agent = 'node';
    const agentArgs = path.resolve(__dirname, '../dist/cmd/photo-agent.js');
    const cwd = path.resolve(__dirname, '..');
    
    // Create a script that simulates opening resources
    const script = `
      const { spawn } = require('child_process');
      const readline = require('readline');
      const path = require('path');
      
      const child = spawn('node', [
        '${client}',
        '--agent', '${agent}',
        '--agentArgs', '${agentArgs}',
        '--cwd', '${cwd}',
        '--interactive'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      
      const rl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity
      });
      
      let sentOpen = false;
      let receivedAck = false;
      
      rl.on('line', (line) => {
        process.stdout.write(line + '\\n');
        
        // Wait for prompt
        if (line.includes('>') && !sentOpen) {
          sentOpen = true;
          child.stdin.write(':open /fake/path/peppers.jpg /fake/path/photo.raf\\n');
        }
        
        // Wait for acknowledgment
        if (line.includes('[agent] ack:')) {
          receivedAck = true;
        }
        
        // Exit after getting stopReason
        if (line.includes('stopReason') && receivedAck) {
          setTimeout(() => {
            child.stdin.write(':exit\\n');
          }, 100);
        }
      });
      
      child.stderr.on('data', (data) => {
        process.stderr.write(data);
      });
      
      child.on('close', (code) => {
        process.exit(code || 0);
      });
    `;
    
    const proc = spawn('node', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    const lines: string[] = [];
    proc.stdout.on('data', (buf) => {
      const s = buf.toString('utf8');
      for (const line of s.split('\n')) {
        if (line.trim().length) lines.push(line.trim());
      }
    });
    
    proc.on('close', (code) => resolve({ code: code ?? -1, out: lines }));
  });
}

describe('Phase 1 - Resource Links', () => {
  it('acknowledges resource_links correctly', async () => {
    const { code, out } = await runOpenDemo();
    
    // Find the agent's acknowledgment
    const ackLine = out.find(l => l.includes('[agent]') && l.includes('ack:'));
    expect(ackLine).toBeDefined();
    expect(ackLine).toContain('ack: 2 resources');
    expect(ackLine).toContain('peppers.jpg');
    
    // Check for end_turn
    const stopLine = out.find(l => l.includes('stopReason') && l.includes('end_turn'));
    expect(stopLine).toBeDefined();
  }, 10000);
  
  it('guesses MIME types correctly', () => {
    // Unit test for MIME type guessing
    const { guessMimeType } = require('../dist/src/common/mime');
    
    expect(guessMimeType('photo.jpg')).toBe('image/jpeg');
    expect(guessMimeType('photo.JPEG')).toBe('image/jpeg');
    expect(guessMimeType('photo.png')).toBe('image/png');
    expect(guessMimeType('photo.raf')).toBe('image/x-raw');
    expect(guessMimeType('photo.nef')).toBe('image/x-raw');
    expect(guessMimeType('photo.arw')).toBe('image/x-raw');
    expect(guessMimeType('photo.txt')).toBeUndefined();
  });
});