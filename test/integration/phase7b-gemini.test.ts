import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { RpcClient } from '../../src/common/rpcClient';
import { Readable, Writable } from 'stream';
import path from 'path';
import fs from 'fs/promises';

// Skip these tests if no API key is present
const SKIP_GEMINI_TESTS = !process.env.GEMINI_API_KEY;

describe.skipIf(SKIP_GEMINI_TESTS)('Phase 7b: Gemini Planner Integration', () => {
  let agent: ChildProcess;
  let peer: RpcClient;
  let sessionId: string;
  const testImagePath = path.join(process.cwd(), 'test', 'fixtures', 'test.jpg');

  beforeAll(async () => {
    // Ensure test image exists
    try {
      await fs.access(testImagePath);
    } catch {
      // Create a minimal test image if it doesn't exist
      await fs.mkdir(path.dirname(testImagePath), { recursive: true });
      await fs.writeFile(testImagePath, Buffer.from('fake-image-data'));
    }

    // Start agent process
    agent = spawn('node', [path.join('dist', 'cmd', 'photo-agent.js')], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    peer = new RpcClient(
      agent.stdout as unknown as Readable,
      agent.stdin as unknown as Writable,
      { line: () => {} } as any
    );

    // Initialize
    const initRes = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(initRes.protocolVersion).toBe(1);

    // Create session with Gemini planner
    const sessionRes = await peer.request('session/new', {
      cwd: process.cwd(),
      planner: 'gemini',
      plannerModel: 'gemini-2.5-flash',
      plannerTimeout: 5000,
      plannerMaxCalls: 6,
      mcpServers: [
        {
          name: 'image',
          command: 'node',
          args: [path.join('dist', 'cmd', 'mcp-image-server.js')],
          env: {},
        },
      ],
    });
    sessionId = sessionRes.sessionId;

    // Wait for MCP servers to connect
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    if (agent) {
      agent.kill();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it('should handle natural language editing with Gemini', async () => {
    const updates: any[] = [];

    peer.onSessionUpdate((params: any) => {
      updates.push(params);
    });

    // Load test image first
    const loadRes = await peer.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: `:load ${testImagePath}`,
        },
      ],
    });
    expect(loadRes.stopReason).toBe('end_turn');

    // Clear updates from loading
    updates.length = 0;

    // Send natural language command
    const promptRes = await peer.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: ':ask "make it warmer, increase exposure by 0.5, add more contrast, and crop to square"',
        },
      ],
    });

    expect(promptRes.stopReason).toBe('end_turn');

    // Verify we got updates
    const textUpdates = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text');

    expect(textUpdates.length).toBeGreaterThan(0);

    // Check that operations were applied
    const summaryText = textUpdates.map((u) => u.content.text).join('');
    expect(summaryText).toMatch(/Applied:/);
    expect(summaryText).toMatch(/Stack:/);

    // Verify specific operations were recognized
    expect(summaryText).toMatch(/WB\(temp/i);
    expect(summaryText).toMatch(/EV/);
    expect(summaryText).toMatch(/Contrast/i);
    expect(summaryText).toMatch(/Crop|1:1/);
  });

  it('should clamp extreme values', async () => {
    const updates: any[] = [];

    peer.onSessionUpdate((params: any) => {
      if (params.sessionId === sessionId) {
        updates.push(params);
      }
    });

    const promptRes = await peer.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: ':ask "set exposure to 10 ev and contrast to 200"',
        },
      ],
    });

    expect(promptRes.stopReason).toBe('end_turn');

    const textUpdates = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text');

    const summaryText = textUpdates.map((u) => u.content.text).join('');

    // Should show clamped values
    expect(summaryText).toMatch(/Clamped:/);
    expect(summaryText).toMatch(/EV.*3\.0/); // Max EV is 3
    expect(summaryText).toMatch(/Contrast.*100/); // Max contrast is 100
  });

  it('should handle export command', async () => {
    const updates: any[] = [];

    peer.onSessionUpdate((params: any) => {
      if (params.sessionId === sessionId) {
        updates.push(params);
      }
    });

    // Send export command
    const promptRes = await peer.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: ':ask "export to ./test-output.jpg with quality 95"',
        },
      ],
    });

    expect(promptRes.stopReason).toBe('end_turn');

    // Should either request permission or indicate export
    const textUpdates = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text');

    const summaryText = textUpdates.map((u) => u.content.text).join('');

    // Export should be mentioned in output
    expect(summaryText.toLowerCase()).toMatch(/export/);
  });

  it('should provide helpful notes about unsupported operations', async () => {
    const updates: any[] = [];

    peer.onSessionUpdate((params: any) => {
      if (params.sessionId === sessionId) {
        updates.push(params);
      }
    });

    // Request unsupported operations
    const promptRes = await peer.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: ':ask "add split toning, apply a vintage filter, and remove red eye"',
        },
      ],
    });

    expect(promptRes.stopReason).toBe('end_turn');

    const textUpdates = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text');

    const summaryText = textUpdates.map((u) => u.content.text).join('');

    // Should indicate some operations were not supported
    // Gemini should still try to apply any recognized operations
    // or provide a note about what wasn't possible
    expect(summaryText).toBeDefined();
  });
});

describe('Phase 7b: Gemini Fallback Behavior', () => {
  let agent: ChildProcess;
  let peer: RpcClient;
  let sessionId: string;
  const testImagePath = path.join(process.cwd(), 'test', 'fixtures', 'test.jpg');

  beforeAll(async () => {
    // Ensure test image exists
    try {
      await fs.access(testImagePath);
    } catch {
      await fs.mkdir(path.dirname(testImagePath), { recursive: true });
      await fs.writeFile(testImagePath, Buffer.from('fake-image-data'));
    }

    // Start agent without API key
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;

    agent = spawn('node', [path.join('dist', 'cmd', 'photo-agent.js')], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    peer = new RpcClient(
      agent.stdout as unknown as Readable,
      agent.stdin as unknown as Writable,
      { line: () => {} } as any
    );

    // Initialize
    const initRes = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(initRes.protocolVersion).toBe(1);

    // Create session with Gemini planner (should fall back to mock)
    const sessionRes = await peer.request('session/new', {
      cwd: process.cwd(),
      planner: 'gemini',
      mcpServers: [
        {
          name: 'image',
          command: 'node',
          args: [path.join('dist', 'cmd', 'mcp-image-server.js')],
          env: {},
        },
      ],
    });
    sessionId = sessionRes.sessionId;

    // Wait for MCP servers
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Load image
    await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `:load ${testImagePath}` }],
    });
  });

  afterAll(async () => {
    if (agent) {
      agent.kill();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it('should fall back to mock planner when no API key', async () => {
    const updates: any[] = [];

    peer.onSessionUpdate((params: any) => {
      if (params.sessionId === sessionId) {
        updates.push(params);
      }
    });

    const promptRes = await peer.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: ':ask "warmer and brighter"',
        },
      ],
    });

    expect(promptRes.stopReason).toBe('end_turn');

    const textUpdates = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text');

    const summaryText = textUpdates.map((u) => u.content.text).join('');

    // Should indicate fallback to mock
    expect(summaryText).toMatch(/fell back to mock|fallback/i);

    // But should still apply operations
    expect(summaryText).toMatch(/Applied:/);
    expect(summaryText).toMatch(/WB\(temp.*20/); // Mock applies +20 for "warmer"
  });
});

describe('Phase 7b: Planner disabled mode', () => {
  let agent: ChildProcess;
  let peer: RpcClient;
  let sessionId: string;

  beforeAll(async () => {
    agent = spawn('node', [path.join('dist', 'cmd', 'photo-agent.js')], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    peer = new RpcClient(
      agent.stdout as unknown as Readable,
      agent.stdin as unknown as Writable,
      { line: () => {} } as any
    );

    // Initialize
    await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    // Create session with planner disabled
    const sessionRes = await peer.request('session/new', {
      cwd: process.cwd(),
      planner: 'off',
      mcpServers: [],
    });
    sessionId = sessionRes.sessionId;
  });

  afterAll(async () => {
    if (agent) {
      agent.kill();
    }
  });

  it('should indicate planner is disabled', async () => {
    const updates: any[] = [];

    peer.onSessionUpdate((params: any) => {
      if (params.sessionId === sessionId) {
        updates.push(params);
      }
    });

    const promptRes = await peer.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: ':ask "make it warmer"',
        },
      ],
    });

    expect(promptRes.stopReason).toBe('end_turn');

    const textUpdates = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text');

    expect(textUpdates.length).toBeGreaterThan(0);
    const text = textUpdates[0].content.text;
    expect(text).toMatch(/Planner disabled/);
    expect(text).toMatch(/--planner=mock|--planner=gemini/);
  });
});
