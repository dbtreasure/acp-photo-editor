"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
function runOpenDemo() {
    return new Promise((resolve) => {
        const client = path_1.default.resolve(__dirname, '../dist/cmd/photo-client.js');
        const agent = 'node';
        const agentArgs = path_1.default.resolve(__dirname, '../dist/cmd/photo-agent.js');
        const cwd = path_1.default.resolve(__dirname, '..');
        // Create a script that simulates opening resources
        const script = `
      const { spawn } = require('child_process');
      const path = require('path');
      
      const child = spawn('node', [
        '${client}',
        '--agent', '${agent}',
        '--agentArgs', '${agentArgs}',
        '--cwd', '${cwd}',
        '--interactive'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      
      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
        process.stdout.write(data);
      });
      
      child.stderr.on('data', (data) => {
        process.stderr.write(data);
      });
      
      // Wait for initialization
      setTimeout(() => {
        // Send :open command with two fake paths
        child.stdin.write(':open /fake/path/peppers.jpg /fake/path/photo.raf\\n');
        
        // Wait for response then exit
        setTimeout(() => {
          child.stdin.write(':exit\\n');
        }, 1000);
      }, 1000);
      
      child.on('close', (code) => {
        process.exit(code || 0);
      });
    `;
        const proc = (0, child_process_1.spawn)('node', ['-e', script], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const lines = [];
        proc.stdout.on('data', (buf) => {
            const s = buf.toString('utf8');
            for (const line of s.split('\n')) {
                if (line.trim().length)
                    lines.push(line.trim());
            }
        });
        proc.on('close', (code) => resolve({ code: code ?? -1, out: lines }));
    });
}
(0, vitest_1.describe)('Phase 1 - Resource Links', () => {
    (0, vitest_1.it)('acknowledges resource_links correctly', async () => {
        const { code, out } = await runOpenDemo();
        // Find the agent's acknowledgment
        const ackLine = out.find(l => l.includes('[agent]') && l.includes('ack:'));
        (0, vitest_1.expect)(ackLine).toBeDefined();
        (0, vitest_1.expect)(ackLine).toContain('ack: 2 resources');
        (0, vitest_1.expect)(ackLine).toContain('peppers.jpg');
        // Check for end_turn
        const stopLine = out.find(l => l.includes('stopReason') && l.includes('end_turn'));
        (0, vitest_1.expect)(stopLine).toBeDefined();
    }, 10000);
    (0, vitest_1.it)('guesses MIME types correctly', () => {
        // Unit test for MIME type guessing
        const { guessMimeType } = require('../dist/src/common/mime');
        (0, vitest_1.expect)(guessMimeType('photo.jpg')).toBe('image/jpeg');
        (0, vitest_1.expect)(guessMimeType('photo.JPEG')).toBe('image/jpeg');
        (0, vitest_1.expect)(guessMimeType('photo.png')).toBe('image/png');
        (0, vitest_1.expect)(guessMimeType('photo.raf')).toBe('image/x-raw');
        (0, vitest_1.expect)(guessMimeType('photo.nef')).toBe('image/x-raw');
        (0, vitest_1.expect)(guessMimeType('photo.arw')).toBe('image/x-raw');
        (0, vitest_1.expect)(guessMimeType('photo.txt')).toBeUndefined();
    });
});
