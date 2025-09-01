import { describe, it, expect } from 'vitest';
import { MockPlanner } from '../../src/planner/mock';

describe('MockPlanner', () => {
  const planner = new MockPlanner();

  describe('White Balance', () => {
    it('should parse warmer/cooler commands', () => {
      const result = planner.plan({ text: 'warmer' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_white_balance_temp_tint',
        args: { temp: 20, tint: 0 },
      });
    });

    it('should accumulate multiple warm/cool adjustments', () => {
      const result = planner.plan({ text: 'warmer, warmer, cooler' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_white_balance_temp_tint',
        args: { temp: 20, tint: 0 }, // 20 + 20 - 20 = 20
      });
    });

    it('should parse cool by N pattern', () => {
      const result = planner.plan({ text: 'cool by 15' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_white_balance_temp_tint',
        args: { temp: -15, tint: 0 },
      });
    });

    it('should parse temp and tint adjustments', () => {
      const result = planner.plan({ text: 'temp +30 tint -10' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_white_balance_temp_tint',
        args: { temp: 30, tint: -10 },
      });
    });

    it('should parse neutral/auto wb', () => {
      const result = planner.plan({ text: 'neutral wb' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_white_balance_gray',
        args: { x: 0.5, y: 0.5 },
      });
    });
  });

  describe('Exposure', () => {
    it('should parse brighter/darker commands', () => {
      const result = planner.plan({ text: 'brighter' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_exposure',
        args: { ev: 0.3 },
      });
    });

    it('should parse EV adjustments', () => {
      const result = planner.plan({ text: 'ev +1.5' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_exposure',
        args: { ev: 1.5 },
      });
    });

    it('should parse prefix EV notation', () => {
      const result = planner.plan({ text: '+0.5 ev' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_exposure',
        args: { ev: 0.5 },
      });
    });

    it('should accumulate exposure adjustments', () => {
      const result = planner.plan({ text: 'brighter, darker, ev +1' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_exposure',
        args: { ev: 1 }, // 0.3 - 0.3 + 1 = 1
      });
    });
  });

  describe('Contrast', () => {
    it('should parse more/less contrast', () => {
      const result = planner.plan({ text: 'more contrast' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_contrast',
        args: { amt: 20 },
      });
    });

    it('should parse punchier/flatter', () => {
      const result = planner.plan({ text: 'punchier' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_contrast',
        args: { amt: 20 },
      });
    });

    it('should parse contrast values', () => {
      const result = planner.plan({ text: 'contrast -30' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_contrast',
        args: { amt: -30 },
      });
    });

    it('should accumulate contrast adjustments', () => {
      const result = planner.plan({ text: 'contrast 35, contrast 10' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_contrast',
        args: { amt: 45 }, // 35 + 10 = 45
      });
    });
  });

  describe('Crop and Aspect Ratios', () => {
    it('should parse square crop', () => {
      const result = planner.plan({ text: 'crop square' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_crop',
        args: { aspect: '1:1' },
      });
    });

    it('should parse aspect ratios', () => {
      const result = planner.plan({ text: '16:9' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_crop',
        args: { aspect: '16:9' },
      });
    });

    it('should parse straighten/rotate', () => {
      const result = planner.plan({ text: 'straighten 1.5' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_crop',
        args: { angleDeg: 1.5 },
      });
    });

    it('should parse angle with degree symbol', () => {
      const result = planner.plan({ text: 'rotate -2.3°' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_crop',
        args: { angleDeg: -2.3 },
      });
    });

    it('should combine aspect and angle in single crop', () => {
      const result = planner.plan({ text: '3:2 straighten 1.2' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'set_crop',
        args: { aspect: '3:2', angleDeg: 1.2 },
      });
    });
  });

  describe('Undo/Redo/Reset', () => {
    it('should parse undo', () => {
      const result = planner.plan({ text: 'undo' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({ fn: 'undo' });
    });

    it('should parse multiple undos', () => {
      const result = planner.plan({ text: 'undo undo redo' });
      expect(result.calls).toHaveLength(3);
      expect(result.calls[0]).toEqual({ fn: 'undo' });
      expect(result.calls[1]).toEqual({ fn: 'undo' });
      expect(result.calls[2]).toEqual({ fn: 'redo' });
    });

    it('should parse reset', () => {
      const result = planner.plan({ text: 'reset' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({ fn: 'reset' });
    });
  });

  describe('Export', () => {
    it('should parse basic export', () => {
      const result = planner.plan({ text: 'export' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({ fn: 'export_image' });
    });

    it('should parse export with destination', () => {
      const result = planner.plan({ text: 'export to ./output.jpg' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'export_image',
        args: { dst: './output.jpg' },
      });
    });

    it('should parse export with format and quality', () => {
      const result = planner.plan({ text: 'export as png quality 95' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'export_image',
        args: { format: 'png', quality: 95 },
      });
    });

    it('should parse export with overwrite', () => {
      const result = planner.plan({ text: 'export to test.jpg overwrite' });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        fn: 'export_image',
        args: { dst: 'test.jpg', overwrite: true },
      });
    });
  });

  describe('Complex Commands', () => {
    it('should parse multiple operations', () => {
      const result = planner.plan({ text: 'warmer, +0.5 ev, more contrast, crop square' });
      expect(result.calls).toHaveLength(4);
      expect(result.calls[0]).toEqual({
        fn: 'set_white_balance_temp_tint',
        args: { temp: 20, tint: 0 },
      });
      expect(result.calls[1]).toEqual({
        fn: 'set_exposure',
        args: { ev: 0.5 },
      });
      expect(result.calls[2]).toEqual({
        fn: 'set_contrast',
        args: { amt: 20 },
      });
      expect(result.calls[3]).toEqual({
        fn: 'set_crop',
        args: { aspect: '1:1' },
      });
    });

    it('should handle mixed separators', () => {
      const result = planner.plan({ text: 'cool by 15; contrast -10, 16:9 straighten 1.2°' });
      expect(result.calls).toHaveLength(3);
      expect(result.calls[0]).toEqual({
        fn: 'set_white_balance_temp_tint',
        args: { temp: -15, tint: 0 },
      });
      expect(result.calls[1]).toEqual({
        fn: 'set_contrast',
        args: { amt: -10 },
      });
      // Note: crop combines aspect and angle
      expect(result.calls[2]).toEqual({
        fn: 'set_crop',
        args: { aspect: '16:9', angleDeg: 1.2 },
      });
    });

    it('should track ignored terms', () => {
      const result = planner.plan({ text: 'warmer, foo, bar, contrast 10' });
      expect(result.calls).toHaveLength(2);
      expect(result.notes).toContain('Ignored terms: foo, bar');
    });
  });

  describe('Operation Ordering', () => {
    it('should place color operations before geometry operations', () => {
      const result = planner.plan({ text: 'crop square, warmer, contrast 10, straighten 2' });

      // Should reorder to: warmer, contrast, then crop
      expect(result.calls).toHaveLength(3);
      expect(result.calls[0].fn).toBe('set_white_balance_temp_tint');
      expect(result.calls[1].fn).toBe('set_contrast');
      expect(result.calls[2].fn).toBe('set_crop');
      expect((result.calls[2] as any).args.aspect).toBe('1:1');
      expect((result.calls[2] as any).args.angleDeg).toBe(2);
    });

    it('should combine multiple crop operations into one', () => {
      const result = planner.plan({ text: '16:9, straighten 2, straighten 3' });

      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].fn).toBe('set_crop');
      expect((result.calls[0] as any).args.aspect).toBe('16:9');
      expect((result.calls[0] as any).args.angleDeg).toBe(5); // 2 + 3
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty text', () => {
      const result = planner.plan({ text: '' });
      expect(result.calls).toHaveLength(0);
    });

    it('should handle unknown commands', () => {
      const result = planner.plan({ text: 'foo bar baz' });
      expect(result.calls).toHaveLength(0);
      expect(result.notes).toContain('Ignored terms: foo, bar, baz');
    });

    it('should handle case insensitivity', () => {
      const result = planner.plan({ text: 'WARMER CROP SQUARE' });
      expect(result.calls).toHaveLength(2);
      expect(result.calls[0].fn).toBe('set_white_balance_temp_tint');
      expect(result.calls[1].fn).toBe('set_crop');
    });
  });
});
