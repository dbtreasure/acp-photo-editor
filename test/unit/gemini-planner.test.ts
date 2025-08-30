import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiPlanner, PlannerState } from '../../src/planner/gemini';

// Global mock for generateContent
const mockGenerateContent = vi.fn();

// Mock the Google GenAI module
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      return {
        models: {
          generateContent: mockGenerateContent
        }
      };
    }
  },
  Type: {
    OBJECT: 'object',
    ARRAY: 'array',
    STRING: 'string'
  }
}));

describe('GeminiPlanner', () => {
  let planner: GeminiPlanner;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent.mockClear();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  describe('without API key', () => {
    beforeEach(() => {
      delete process.env.GEMINI_API_KEY;
      planner = new GeminiPlanner();
    });

    it('should fall back to mock planner when no API key', async () => {
      const result = await planner.plan({ text: 'warmer, +0.5 ev' });
      
      expect(result.calls).toHaveLength(2);
      expect(result.notes).toContain('Planner fell back to mock (no API key).');
    });
  });

  describe('with API key', () => {
    beforeEach(() => {
      process.env.GEMINI_API_KEY = 'test-api-key';
      planner = new GeminiPlanner({ timeout: 100 });
    });

    it('should parse valid JSON response into planned calls', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          calls: [
            { fn: 'set_white_balance_temp_tint', args: { temp: 20, tint: 0 } },
            { fn: 'set_exposure', args: { ev: 0.5 } },
            { fn: 'set_contrast', args: { amt: 25 } },
            { fn: 'set_crop', args: { aspect: '1:1' } }
          ]
        })
      });

      const result = await planner.plan({ 
        text: 'warmer, +0.5 ev, more contrast, crop square' 
      });

      expect(result.calls).toHaveLength(4);
      expect(result.calls[0]).toEqual({
        fn: 'set_white_balance_temp_tint',
        args: { temp: 20, tint: 0 }
      });
      expect(result.calls[1]).toEqual({
        fn: 'set_exposure',
        args: { ev: 0.5 }
      });
    });

    it('should clamp values outside valid ranges', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          calls: [
            { fn: 'set_exposure', args: { ev: 10 } },
            { fn: 'set_contrast', args: { amt: 200 } },
            { fn: 'set_white_balance_temp_tint', args: { temp: 150, tint: -150 } }
          ]
        })
      });

      const result = await planner.plan({ text: 'extreme adjustments' });

      expect((result.calls[0] as any).args).toEqual({ ev: 3 }); // Clamped to max
      expect((result.calls[1] as any).args).toEqual({ amt: 100 }); // Clamped to max
      expect((result.calls[2] as any).args).toEqual({ temp: 100, tint: -100 }); // Both clamped
      expect(result.notes).toContain('Clamped values');
    });

    it('should drop invalid calls', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          calls: [
            { fn: 'set_exposure', args: { ev: 0.5 } },
            { fn: 'unknown_function', args: {} },
            { fn: 'set_contrast' }, // Missing args
            { fn: 'set_white_balance_temp_tint', args: { temp: 20 } } // Missing tint
          ]
        })
      });

      const result = await planner.plan({ text: 'various operations' });

      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].fn).toBe('set_exposure');
      expect(result.notes).toContain('Dropped invalid calls');
    });

    it('should handle timeout and fall back to mock', async () => {
      mockGenerateContent.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ text: '{"calls":[]}' }), 200);
      }));

      const result = await planner.plan({ text: 'warmer' });

      expect(result.notes).toContain('Planner fell back to mock (timeout).');
      expect(result.calls.length).toBeGreaterThan(0); // Mock should return something
    });

    it('should handle API errors and fall back to mock', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await planner.plan({ text: 'warmer' });

      expect(result.notes).toContain('Planner fell back to mock');
      expect(result.calls.length).toBeGreaterThan(0);
    });

    it('should truncate calls to maxCalls limit', async () => {
      planner = new GeminiPlanner({ 
        apiKey: 'test-key',
        maxCalls: 3 
      });

      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          calls: [
            { fn: 'set_exposure', args: { ev: 0.5 } },
            { fn: 'set_contrast', args: { amt: 20 } },
            { fn: 'set_white_balance_temp_tint', args: { temp: 10, tint: 0 } },
            { fn: 'set_crop', args: { aspect: '16:9' } },
            { fn: 'undo' }
          ]
        })
      });

      const result = await planner.plan({ text: 'many operations' });

      expect(result.calls).toHaveLength(3);
      expect(result.notes).toContain('Truncated to 3 calls (from 5)');
    });

    it('should include planner state in prompt when provided', async () => {
      const state: PlannerState = {
        image: {
          name: 'test.jpg',
          w: 3000,
          h: 2000,
          mime: 'image/jpeg'
        },
        stackSummary: 'WB temp +10 • EV +0.5',
        limits: {
          temp: [-100, 100],
          ev: [-3, 3],
          contrast: [-100, 100],
          angle: [-45, 45]
        }
      };

      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ calls: [] })
      });

      await planner.plan({ text: 'adjust', state });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.contents[1].parts[0].text).toContain('test.jpg');
      expect(callArgs.contents[1].parts[0].text).toContain('3000x2000');
      expect(callArgs.contents[1].parts[0].text).toContain('WB temp +10');
    });

    it('should handle export operations correctly', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          calls: [
            { 
              fn: 'export_image', 
              args: { 
                dst: './output.jpg',
                format: 'jpeg',
                quality: 95,
                overwrite: true
              }
            }
          ]
        })
      });

      const result = await planner.plan({ text: 'export to output.jpg' });

      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'export_image',
        args: {
          dst: './output.jpg',
          format: 'jpeg',
          quality: 95,
          overwrite: true
        }
      });
    });

    it('should handle undo/redo/reset operations', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          calls: [
            { fn: 'undo' },
            { fn: 'redo' },
            { fn: 'reset' }
          ]
        })
      });

      const result = await planner.plan({ text: 'undo then redo then reset' });

      expect(result.calls).toHaveLength(3);
      expect(result.calls[0].fn).toBe('undo');
      expect(result.calls[1].fn).toBe('redo');
      expect(result.calls[2].fn).toBe('reset');
    });
  });

  describe('response validation', () => {
    beforeEach(() => {
      process.env.GEMINI_API_KEY = 'test-api-key';
      planner = new GeminiPlanner();
    });

    it('should handle invalid JSON response', async () => {
      mockGenerateContent.mockResolvedValue({
        text: 'Not valid JSON at all'
      });

      const result = await planner.plan({ text: 'warmer' });

      expect(result.notes).toContain('Planner fell back to mock');
    });

    it('should handle missing calls array', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({ notCalls: [] })
      });

      const result = await planner.plan({ text: 'warmer' });

      expect(result.notes).toContain('Planner fell back to mock');
    });

    it('should handle crop with rotation', async () => {
      mockGenerateContent.mockResolvedValue({
        text: JSON.stringify({
          calls: [
            { 
              fn: 'set_crop', 
              args: { 
                aspect: '16:9',
                angleDeg: 15 
              }
            }
          ]
        })
      });

      const result = await planner.plan({ text: 'crop 16:9 and rotate' });

      expect(result.calls[0]).toEqual({
        fn: 'set_crop',
        args: {
          aspect: '16:9',
          angleDeg: 15
        }
      });
    });
  });
});