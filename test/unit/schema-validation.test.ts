import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS, validateAndClampCall } from '../../src/planner/tools';
import { PlannedCall } from '../../src/planner/types';

describe('Schema round-trip validation', () => {
  describe('Tool schema completeness', () => {
    it('should have schemas for all supported functions', () => {
      const supportedFunctions = [
        'set_white_balance_temp_tint',
        'set_white_balance_gray',
        'set_exposure',
        'set_contrast',
        'set_crop',
        'undo',
        'redo',
        'reset',
        'export_image',
      ];

      for (const fn of supportedFunctions) {
        expect((TOOL_SCHEMAS as any)[fn]).toBeDefined();
        expect((TOOL_SCHEMAS as any)[fn].properties.fn).toBeDefined();
      }
    });
  });

  describe('Sample response validation', () => {
    it('should validate a complete editing workflow', () => {
      const sampleResponse: PlannedCall[] = [
        // Color adjustments
        { fn: 'set_white_balance_temp_tint', args: { temp: 25, tint: 0 } },
        { fn: 'set_exposure', args: { ev: 0.4 } },
        { fn: 'set_contrast', args: { amt: 30 } },
        // Geometry adjustment
        { fn: 'set_crop', args: { aspect: '1:1' } },
        // Export
        { fn: 'export_image', args: { dst: 'output.jpg', format: 'jpeg', quality: 95 } },
      ];

      // Validate all calls pass schema validation
      for (const call of sampleResponse) {
        const validated = validateAndClampCall(call);
        expect(validated).not.toBeNull();
        expect(validated?.fn).toBe(call.fn);

        // Verify the validated call maintains the structure
        if ((call as any).args) {
          expect((validated as any)?.args).toBeDefined();
          for (const key of Object.keys((call as any).args)) {
            expect((validated as any)?.args).toHaveProperty(key);
          }
        }
      }
    });

    it('should validate operations with all optional parameters', () => {
      const calls: PlannedCall[] = [
        {
          fn: 'set_crop',
          args: {
            aspect: '16:9',
            rectNorm: [0.1, 0.1, 0.8, 0.8],
          },
        },
        {
          fn: 'export_image',
          args: {
            dst: 'final.png',
            format: 'png',
            quality: 100,
            overwrite: true,
          },
        },
      ];

      for (const call of calls) {
        const validated = validateAndClampCall(call);
        expect(validated).not.toBeNull();

        // Check all parameters are preserved
        if ((call as any).args && (validated as any)?.args) {
          for (const [key, value] of Object.entries((call as any).args)) {
            if (key === 'rectNorm' && Array.isArray(value)) {
              expect((validated as any).args[key]).toHaveLength(4);
            } else {
              expect((validated as any).args).toHaveProperty(key);
            }
          }
        }
      }
    });

    it('should validate gray point picker coordinates', () => {
      const call: PlannedCall = {
        fn: 'set_white_balance_gray',
        args: { x: 0.5, y: 0.5 },
      };

      const validated = validateAndClampCall(call);
      expect(validated).not.toBeNull();
      expect((validated as any)?.args).toEqual({ x: 0.5, y: 0.5 });
    });

    it('should clamp out-of-bounds rectNorm values', () => {
      const call = {
        fn: 'set_crop',
        args: {
          rectNorm: [-0.1, 1.2, 0.5, 0.5], // Out of bounds
        },
      };

      const validated = validateAndClampCall(call);
      expect(validated).not.toBeNull();
      expect((validated as any)?.args?.rectNorm).toEqual([0, 1, 0.5, 0.5]); // Clamped to 0-1
    });
  });

  describe('Error cases', () => {
    it('should reject operations with wrong parameter types', () => {
      const invalidCalls = [
        { fn: 'set_exposure', args: { ev: 'bright' } }, // String instead of number
        { fn: 'set_white_balance_temp_tint', args: { temp: 50, tint: '0' } }, // String tint
        { fn: 'set_crop', args: { aspect: 100 } }, // Number instead of string
        { fn: 'export_image', args: { quality: '95' } }, // String instead of number
      ];

      for (const call of invalidCalls) {
        const validated = validateAndClampCall(call as any);
        expect(validated).toBeNull();
      }
    });

    it('should reject operations with invalid enum values', () => {
      const invalidCalls = [
        { fn: 'set_crop', args: { aspect: '5:4' } }, // Invalid aspect ratio
        { fn: 'export_image', args: { format: 'webp' } }, // Unsupported format
      ];

      for (const call of invalidCalls) {
        const validated = validateAndClampCall(call);
        expect(validated).toBeNull();
      }
    });
  });

  describe('Accumulation and ordering', () => {
    it('should validate proper operation ordering', () => {
      const operations: PlannedCall[] = [
        // All color/tonal adjustments first
        { fn: 'set_white_balance_temp_tint', args: { temp: 20, tint: 0 } },
        { fn: 'set_exposure', args: { ev: 0.3 } },
        { fn: 'set_contrast', args: { amt: 25 } },
        // Then geometry
        { fn: 'set_rotate', args: { angleDeg: 2 } },
        { fn: 'set_crop', args: { aspect: '16:9' } },
        // Finally export
        { fn: 'export_image', args: { dst: 'final.jpg', format: 'jpeg', quality: 90 } },
      ];

      // Validate all operations
      const validated = operations.map((op) => validateAndClampCall(op));
      expect(validated.every((v) => v !== null)).toBe(true);

      // Check ordering constraints
      const fnOrder = validated.map((v) => v!.fn as string);
      const cropIndex = fnOrder.indexOf('set_crop');
      const exportIndex = fnOrder.indexOf('export_image');
      const colorOps = ['set_white_balance_temp_tint', 'set_exposure', 'set_contrast'];

      // All color ops should come before crop
      for (const colorOp of colorOps) {
        const index = fnOrder.indexOf(colorOp);
        if (index !== -1) {
          expect(index).toBeLessThan(cropIndex);
        }
      }

      // Export should be last if present
      if (exportIndex !== -1) {
        expect(exportIndex).toBe(fnOrder.length - 1);
      }
    });
  });
});
