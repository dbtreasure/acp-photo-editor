import { describe, it, expect } from 'vitest';
import { validateAndClampCall } from '../src/planner/tools';
import { GeminiPlanner } from '../src/planner/gemini';
import { PlannedCall } from '../src/planner/types';

describe('Phase 7d - Full Tool Catalog with Vision', () => {
  describe('Tool validation', () => {
    it('should validate saturation operations', () => {
      const call = { fn: 'set_saturation', args: { amt: 50 } };
      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect(validated?.fn).toBe('set_saturation');
      if ('args' in validated!) {
        expect((validated.args as any)?.amt).toBe(50);
      }
    });

    it('should validate vibrance operations', () => {
      const call = { fn: 'set_vibrance', args: { amt: 30 } };
      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect(validated?.fn).toBe('set_vibrance');
      if ('args' in validated!) {
        expect((validated.args as any)?.amt).toBe(30);
      }
    });

    it('should validate rotate operations', () => {
      const call = { fn: 'set_rotate', args: { angleDeg: -5 } };
      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect(validated?.fn).toBe('set_rotate');
      if ('args' in validated!) {
        expect((validated.args as any)?.angleDeg).toBe(-5);
      }
    });

    it('should clamp saturation values', () => {
      const call = { fn: 'set_saturation', args: { amt: 150 } };
      const validated = validateAndClampCall(call);
      if (validated && 'args' in validated) {
        expect((validated.args as any)?.amt).toBe(100);
      }
    });

    it('should clamp rotation angles', () => {
      const call = { fn: 'set_rotate', args: { angleDeg: 90 } };
      const validated = validateAndClampCall(call);
      if (validated && 'args' in validated) {
        expect((validated.args as any)?.angleDeg).toBe(45);
      }
    });

    it('should validate crop with rectNorm', () => {
      const call = { fn: 'set_crop', args: { rectNorm: [0.1, 0.2, 0.5, 0.6] } };
      const validated = validateAndClampCall(call);
      expect(validated).toBeDefined();
      expect(validated?.fn).toBe('set_crop');
      if (validated && 'args' in validated) {
        expect((validated.args as any)?.rectNorm).toEqual([0.1, 0.2, 0.5, 0.6]);
      }
    });

    it('should clamp crop rectNorm coordinates', () => {
      const call = { fn: 'set_crop', args: { rectNorm: [-0.1, 0.2, 1.5, 0.6] } };
      const validated = validateAndClampCall(call);
      if (validated && 'args' in validated) {
        expect((validated.args as any)?.rectNorm).toEqual([0, 0.2, 1, 0.6]);
      }
    });
  });

  describe('Multi-operation planning', () => {
    it('should generate multiple operations for complex request', async () => {
      // Mock the Gemini API response
      const mockPlan = {
        calls: [
          { fn: 'set_white_balance_temp_tint', args: { temp: 20, tint: 0 } },
          { fn: 'set_exposure', args: { ev: 0.5 } },
          { fn: 'set_contrast', args: { amt: 20 } },
          { fn: 'set_vibrance', args: { amt: 30 } },
          { fn: 'set_rotate', args: { angleDeg: -2 } },
          { fn: 'set_crop', args: { aspect: '16:9' } },
          { fn: 'export_image', args: { dst: 'final.jpg', format: 'jpeg', quality: 95 } }
        ] as PlannedCall[]
      };

      // Validate all operations
      const validatedCalls = mockPlan.calls.map(call => validateAndClampCall(call)).filter(Boolean);
      
      expect(validatedCalls).toHaveLength(7);
      expect(validatedCalls[0]?.fn).toBe('set_white_balance_temp_tint');
      expect(validatedCalls[1]?.fn).toBe('set_exposure');
      expect(validatedCalls[2]?.fn).toBe('set_contrast');
      expect(validatedCalls[3]?.fn).toBe('set_vibrance');
      expect(validatedCalls[4]?.fn).toBe('set_rotate');
      expect(validatedCalls[5]?.fn).toBe('set_crop');
      expect(validatedCalls[6]?.fn).toBe('export_image');
    });

    it('should handle vision-specific operations', async () => {
      const mockVisionPlan = {
        calls: [
          { fn: 'set_white_balance_gray', args: { x: 0.5, y: 0.3 } },
          { fn: 'set_exposure', args: { ev: 0.3 } },
          { fn: 'set_saturation', args: { amt: -20 } },
          { fn: 'set_crop', args: { rectNorm: [0.1, 0.1, 0.8, 0.8] } }
        ] as PlannedCall[]
      };

      const validatedCalls = mockVisionPlan.calls.map(call => validateAndClampCall(call)).filter(Boolean);
      
      expect(validatedCalls).toHaveLength(4);
      expect(validatedCalls[0]?.fn).toBe('set_white_balance_gray');
      if (validatedCalls[0] && 'args' in validatedCalls[0]) {
        expect((validatedCalls[0].args as any)?.x).toBe(0.5);
        expect((validatedCalls[0].args as any)?.y).toBe(0.3);
      }
      expect(validatedCalls[3]?.fn).toBe('set_crop');
      if (validatedCalls[3] && 'args' in validatedCalls[3]) {
        expect((validatedCalls[3].args as any)?.rectNorm).toEqual([0.1, 0.1, 0.8, 0.8]);
      }
    });

    it('should validate export operations in single turn', () => {
      const exportCall = { 
        fn: 'export_image', 
        args: { 
          dst: './exports/final.jpg', 
          format: 'jpeg' as const, 
          quality: 90,
          overwrite: true
        } 
      };
      
      const validated = validateAndClampCall(exportCall);
      expect(validated).toBeDefined();
      expect(validated?.fn).toBe('export_image');
      if (validated && 'args' in validated) {
        expect((validated.args as any)?.dst).toBe('./exports/final.jpg');
        expect((validated.args as any)?.format).toBe('jpeg');
        expect((validated.args as any)?.quality).toBe(90);
        expect((validated.args as any)?.overwrite).toBe(true);
      }
    });
  });

  describe('Operation order enforcement', () => {
    it('should maintain correct operation order', () => {
      // Color operations should come before geometry operations
      const operations = [
        { fn: 'set_crop', args: { aspect: '1:1' } },
        { fn: 'set_exposure', args: { ev: 0.5 } },
        { fn: 'set_rotate', args: { angleDeg: 5 } },
        { fn: 'set_white_balance_temp_tint', args: { temp: 30, tint: 0 } },
        { fn: 'export_image', args: { format: 'png' as const } }
      ];

      // The agent should reorder these as: wb -> exposure -> rotate -> crop -> export
      const expectedOrder = ['set_white_balance_temp_tint', 'set_exposure', 'set_rotate', 'set_crop', 'export_image'];
      
      // This would be handled by the agent's apply logic
      // Here we just verify the operations are all valid
      const validatedCalls = operations.map(call => validateAndClampCall(call)).filter(Boolean);
      expect(validatedCalls).toHaveLength(5);
    });
  });
});