import { describe, it, expect } from 'vitest';
import { GeminiPlanner } from '../../src/planner/gemini';
import { validateAndClampCall, getClampedValues } from '../../src/planner/tools';

describe('GeminiPlanner offline tests', () => {
  describe('validateAndClampCall', () => {
    it('should validate and clamp white balance temperature/tint', () => {
      const call = {
        fn: 'set_white_balance_temp_tint',
        args: { temp: 150, tint: -150 }, // Out of bounds
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect((validated as any)?.args).toEqual({
        temp: 100, // Clamped to max
        tint: -100, // Clamped to min
      });

      const clamped = getClampedValues(call as any, validated!);
      expect(clamped).toContain('temp clamped from 150 to 100');
      expect(clamped).toContain('tint clamped from -150 to -100');
    });

    it('should validate exposure values', () => {
      const call = {
        fn: 'set_exposure',
        args: { ev: 5 }, // Out of bounds
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect((validated as any)?.args).toEqual({
        ev: 3, // Clamped to max
      });

      const clamped = getClampedValues(call as any, validated!);
      expect(clamped).toContain('EV clamped from 5 to 3');
    });

    it('should validate contrast values', () => {
      const call = {
        fn: 'set_contrast',
        args: { amt: -200 }, // Out of bounds
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect((validated as any)?.args).toEqual({
        amt: -100, // Clamped to min
      });
    });

    it('should validate crop with aspect ratio', () => {
      const call = {
        fn: 'set_crop',
        args: { aspect: '1:1' },
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect((validated as any)?.args).toEqual({
        aspect: '1:1',
      });
    });

    it('should validate crop with angle', () => {
      const call = {
        fn: 'set_crop',
        args: { angleDeg: 90 }, // Out of bounds
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect((validated as any)?.args).toEqual({
        angleDeg: 45, // Clamped to max
      });
    });

    it('should reject invalid crop aspect ratios', () => {
      const call = {
        fn: 'set_crop',
        args: { aspect: '2:1' }, // Invalid aspect
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeNull();
    });

    it('should validate export with quality clamping', () => {
      const call = {
        fn: 'export_image',
        args: {
          dst: 'output.jpg',
          format: 'jpeg',
          quality: 150, // Out of bounds
        },
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect((validated as any)?.args).toEqual({
        dst: 'output.jpg',
        format: 'jpeg',
        quality: 100, // Clamped to max
      });
    });

    it('should handle undo/redo/reset with no args', () => {
      const undoCall = { fn: 'undo' };
      const redoCall = { fn: 'redo' };
      const resetCall = { fn: 'reset' };

      expect(validateAndClampCall(undoCall)).toEqual({ fn: 'undo' });
      expect(validateAndClampCall(redoCall)).toEqual({ fn: 'redo' });
      expect(validateAndClampCall(resetCall)).toEqual({ fn: 'reset' });
    });

    it('should reject calls with missing required parameters', () => {
      const call = {
        fn: 'set_white_balance_temp_tint',
        args: { temp: 50 }, // Missing tint
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeNull();
    });

    it('should reject calls with invalid function names', () => {
      const call = {
        fn: 'invalid_function',
        args: {},
      };

      const validated = validateAndClampCall(call);
      expect(validated).toBeNull();
    });
  });

  describe('Recorded response parsing', () => {
    it('should parse a recorded Gemini response correctly', () => {
      const geminiResponse = {
        calls: [
          { fn: 'set_white_balance_temp_tint', args: { temp: 30, tint: 0 } },
          { fn: 'set_exposure', args: { ev: 0.5 } },
          { fn: 'set_contrast', args: { amt: 20 } },
          { fn: 'set_crop', args: { aspect: '16:9' } },
        ],
      };

      // Validate all calls
      const validated = geminiResponse.calls.map((call) => validateAndClampCall(call));
      expect(validated.every((v) => v !== null)).toBe(true);
      expect(validated.length).toBe(4);

      // Check ordering (color before geometry)
      const fns = validated.map((v) => v!.fn);
      const cropIndex = fns.indexOf('set_crop');
      const colorIndices = [
        fns.indexOf('set_white_balance_temp_tint'),
        fns.indexOf('set_exposure'),
        fns.indexOf('set_contrast'),
      ];

      // All color adjustments should come before crop
      expect(colorIndices.every((i) => i < cropIndex)).toBe(true);
    });

    it('should handle markdown-wrapped JSON responses', () => {
      const wrappedResponse = '```json\n{"calls": [{"fn": "set_exposure", "args": {"ev": 1}}]}\n```';
      const cleaned = wrappedResponse
        .replace(/^```(?:json)?\s*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();
      const parsed = JSON.parse(cleaned);

      expect(parsed.calls).toBeDefined();
      expect(parsed.calls[0].fn).toBe('set_exposure');
    });
  });

  describe('Fallback behavior', () => {
    it('should fall back to mock when no API key is provided', async () => {
      const planner = new GeminiPlanner({ apiKey: '' });
      const result = await planner.plan({ text: 'make it warmer' });

      // Should have returned calls from mock planner
      expect(result.calls.length).toBeGreaterThan(0);
      // The first call should be a temperature adjustment
      expect(result.calls[0].fn).toBe('set_white_balance_temp_tint');
      // Should have a fallback note about no API key
      expect(result.notes).toBeDefined();
      expect(result.notes?.some((n) => n.toLowerCase().includes('mock') || n.toLowerCase().includes('api key'))).toBe(
        true
      );
    });
  });
});
