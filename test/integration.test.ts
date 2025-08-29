
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';

function runDemo(): Promise<{ code:number, out:string[] }> {
  return new Promise((resolve) => {
    const client = path.resolve(__dirname, '../dist/cmd/photo-client.js');
    const agent = 'node';
    const agentArgs = path.resolve(__dirname, '../dist/cmd/photo-agent.js');
    const cwd = path.resolve(__dirname, '..');
    const proc = spawn('node', [client, '--agent', agent, '--agentArgs', agentArgs, '--cwd', cwd, '--demo', 'ping'], {
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

describe('Phase 0 demo', () => {
  it('runs end-to-end and returns end_turn', async () => {
    const { code, out } = await runDemo();
    expect(code).toBe(0);
    const hasChunk = out.some(l => l.startsWith('DEMO:CHUNK') && l.includes('pong'));
    const hasStop = out.some(l => l.startsWith('DEMO:STOP') && l.includes('end_turn'));
    expect(hasChunk).toBe(true);
    expect(hasStop).toBe(true);
  });
});
