import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';

describe('MCP render_preview tool', () => {
  let serverProcess: ChildProcessWithoutNullStreams;
  let requestId = 1;

  beforeAll(async () => {
    // Start MCP server
    const serverPath = path.join(__dirname, '..', 'cmd', 'mcp-image-server.ts');
    serverProcess = spawn('tsx', [serverPath], {
      env: { ...process.env, MCP_ROOT: path.join(__dirname, 'assets') }
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  const sendRequest = (method: string, params: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      const id = requestId++;
      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      
      serverProcess.stdout.once('data', (data) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        } catch (e) {
          reject(e);
        }
      });

      serverProcess.stdin.write(request);
    });
  };

  describe('render_preview', () => {
    it('should render preview with no operations', async () => {
      const testImagePath = path.join(__dirname, 'assets', 'test-landscape.jpg');
      const fileUri = 'file://' + testImagePath;

      const result = await sendRequest('call_tool', {
        name: 'render_preview',
        arguments: {
          uri: fileUri,
          editStack: {
            version: 1,
            baseUri: fileUri,
            ops: []
          },
          maxPx: 256
        }
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('image');
      expect(result.content[0].mimeType).toBe('image/png');
      expect(result.content[0].data).toBeDefined();
    });

    it('should apply crop operation', async () => {
      const testImagePath = path.join(__dirname, 'assets', 'test-landscape.jpg');
      const fileUri = 'file://' + testImagePath;

      const result = await sendRequest('call_tool', {
        name: 'render_preview',
        arguments: {
          uri: fileUri,
          editStack: {
            version: 1,
            baseUri: fileUri,
            ops: [{
              id: 'op_01',
              op: 'crop',
              rectNorm: [0.25, 0.25, 0.5, 0.5]
            }]
          },
          maxPx: 256
        }
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('image');
      // Cropped image should be smaller in base64
      const originalResult = await sendRequest('call_tool', {
        name: 'render_preview',
        arguments: {
          uri: fileUri,
          editStack: { version: 1, baseUri: fileUri, ops: [] },
          maxPx: 256
        }
      });
      
      expect(result.content[0].data.length).toBeLessThan(originalResult.content[0].data.length);
    });

    it('should apply rotation operation', async () => {
      const testImagePath = path.join(__dirname, 'assets', 'test-landscape.jpg');
      const fileUri = 'file://' + testImagePath;

      const result = await sendRequest('call_tool', {
        name: 'render_preview',
        arguments: {
          uri: fileUri,
          editStack: {
            version: 1,
            baseUri: fileUri,
            ops: [{
              id: 'op_01',
              op: 'crop',
              angleDeg: 90
            }]
          },
          maxPx: 256
        }
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('image');
      // Image should be rotated (different from original)
    });

    it('should cache results', async () => {
      const testImagePath = path.join(__dirname, 'assets', 'test-landscape.jpg');
      const fileUri = 'file://' + testImagePath;

      const stack = {
        version: 1,
        baseUri: fileUri,
        ops: [{
          id: 'op_01',
          op: 'crop',
          rectNorm: [0.1, 0.1, 0.8, 0.8]
        }]
      };

      const start = Date.now();
      await sendRequest('call_tool', {
        name: 'render_preview',
        arguments: { uri: fileUri, editStack: stack, maxPx: 256 }
      });
      const firstCallTime = Date.now() - start;

      const cacheStart = Date.now();
      await sendRequest('call_tool', {
        name: 'render_preview',
        arguments: { uri: fileUri, editStack: stack, maxPx: 256 }
      });
      const cachedCallTime = Date.now() - cacheStart;

      // Cached call should be faster
      expect(cachedCallTime).toBeLessThan(firstCallTime / 2);
    });

    it('should handle invalid rect coordinates', async () => {
      const testImagePath = path.join(__dirname, 'assets', 'test-landscape.jpg');
      const fileUri = 'file://' + testImagePath;

      const result = await sendRequest('call_tool', {
        name: 'render_preview',
        arguments: {
          uri: fileUri,
          editStack: {
            version: 1,
            baseUri: fileUri,
            ops: [{
              id: 'op_01',
              op: 'crop',
              rectNorm: [1.5, -0.5, 2.0, 0.5] // Invalid coords
            }]
          },
          maxPx: 256
        }
      });

      // Should clamp and still return valid image
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('image');
    });
  });

  describe('compute_aspect_rect', () => {
    it('should compute square aspect rect', async () => {
      const result = await sendRequest('call_tool', {
        name: 'compute_aspect_rect',
        arguments: {
          width: 1920,
          height: 1080,
          aspect: '1:1'
        }
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.rectNorm).toBeDefined();
      expect(parsed.aspect).toBe('1:1');
      
      const [x, y, w, h] = parsed.rectNorm;
      expect(w).toBeCloseTo(h * (1920/1080), 2);
    });

    it('should handle aspect keywords', async () => {
      const result = await sendRequest('call_tool', {
        name: 'compute_aspect_rect',
        arguments: {
          width: 1000,
          height: 1000,
          aspect: 'square'
        }
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.aspect).toBe('1:1');
      expect(parsed.rectNorm).toEqual([0, 0, 1, 1]);
    });

    it('should handle wide aspect on tall image', async () => {
      const result = await sendRequest('call_tool', {
        name: 'compute_aspect_rect',
        arguments: {
          width: 1080,
          height: 1920,
          aspect: '16:9'
        }
      });

      const parsed = JSON.parse(result.content[0].text);
      const [x, y, w, h] = parsed.rectNorm;
      expect(w).toBe(1);
      expect(h).toBeLessThan(1);
      expect(y).toBeGreaterThan(0); // Should be centered vertically
    });

    it('should reject invalid aspect ratio', async () => {
      await expect(
        sendRequest('call_tool', {
          name: 'compute_aspect_rect',
          arguments: {
            width: 1920,
            height: 1080,
            aspect: 'invalid'
          }
        })
      ).rejects.toThrow();
    });
  });
});