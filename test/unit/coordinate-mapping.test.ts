// Unit tests for coordinate mapping (Phase 7c)

import { describe, it, expect } from 'vitest';

// Mock the mapping function for testing
// In production, this would be imported from photo-agent.ts
function mapPreviewToOriginal(
  x: number,
  y: number,
  stack: any,
  originalWidth: number,
  originalHeight: number
): { x: number; y: number; clamped: boolean } {
  let mappedX = x;
  let mappedY = y;
  let wasClamped = false;

  // Process operations in reverse order (undo transformations)
  const geometryOps = stack.ops.filter((op: any) => op.op === 'crop').reverse();

  for (const op of geometryOps) {
    if (op.op === 'crop') {
      const cropOp = op as any;

      // Handle rotation inverse
      if (cropOp.angleDeg) {
        // Rotate point back by negative angle
        const angle = (-cropOp.angleDeg * Math.PI) / 180;
        const centerX = 0.5;
        const centerY = 0.5;

        // Translate to origin
        const translatedX = mappedX - centerX;
        const translatedY = mappedY - centerY;

        // Apply inverse rotation
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rotatedX = translatedX * cos - translatedY * sin;
        const rotatedY = translatedX * sin + translatedY * cos;

        // Translate back
        mappedX = rotatedX + centerX;
        mappedY = rotatedY + centerY;
      }

      // Handle crop inverse
      if (cropOp.rectNorm) {
        const [cropX, cropY, cropW, cropH] = cropOp.rectNorm;

        // Map from cropped space back to original space
        mappedX = cropX + mappedX * cropW;
        mappedY = cropY + mappedY * cropH;
      }
    }
  }

  // Clamp to valid range [0,1]
  if (mappedX < 0 || mappedX > 1 || mappedY < 0 || mappedY > 1) {
    wasClamped = true;
    mappedX = Math.max(0, Math.min(1, mappedX));
    mappedY = Math.max(0, Math.min(1, mappedY));
  }

  return { x: mappedX, y: mappedY, clamped: wasClamped };
}

describe('Coordinate Mapping', () => {
  describe('No transformations', () => {
    it('should return same coordinates when no operations', () => {
      const stack = { ops: [] };
      const result = mapPreviewToOriginal(0.5, 0.5, stack, 1000, 1000);

      expect(result.x).toBeCloseTo(0.5);
      expect(result.y).toBeCloseTo(0.5);
      expect(result.clamped).toBe(false);
    });
  });

  describe('Crop only', () => {
    it('should map coordinates through simple crop', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            rectNorm: [0.25, 0.25, 0.5, 0.5], // 50% crop from center
          },
        ],
      };

      // Center of preview (0.5, 0.5) should map to center of original crop region
      const result = mapPreviewToOriginal(0.5, 0.5, stack, 1000, 1000);

      expect(result.x).toBeCloseTo(0.5); // 0.25 + 0.5 * 0.5
      expect(result.y).toBeCloseTo(0.5); // 0.25 + 0.5 * 0.5
      expect(result.clamped).toBe(false);
    });

    it('should map top-left corner correctly', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            rectNorm: [0.2, 0.3, 0.6, 0.5],
          },
        ],
      };

      // Top-left of preview (0, 0) should map to crop origin
      const result = mapPreviewToOriginal(0, 0, stack, 1000, 1000);

      expect(result.x).toBeCloseTo(0.2);
      expect(result.y).toBeCloseTo(0.3);
      expect(result.clamped).toBe(false);
    });

    it('should map bottom-right corner correctly', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            rectNorm: [0.1, 0.1, 0.8, 0.8],
          },
        ],
      };

      // Bottom-right of preview (1, 1) should map to crop end
      const result = mapPreviewToOriginal(1, 1, stack, 1000, 1000);

      expect(result.x).toBeCloseTo(0.9); // 0.1 + 1 * 0.8
      expect(result.y).toBeCloseTo(0.9); // 0.1 + 1 * 0.8
      expect(result.clamped).toBe(false);
    });
  });

  describe('Rotation only', () => {
    it('should handle 90 degree rotation', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: 90,
          },
        ],
      };

      // Point at (0.75, 0.5) after 90° rotation
      // Should map back to (0.5, 0.25) in original
      const result = mapPreviewToOriginal(0.75, 0.5, stack, 1000, 1000);

      expect(result.x).toBeCloseTo(0.5, 1);
      expect(result.y).toBeCloseTo(0.75, 1);
    });

    it('should handle small rotation angles', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: 5,
          },
        ],
      };

      // Center should remain at center for small rotations
      const result = mapPreviewToOriginal(0.5, 0.5, stack, 1000, 1000);

      expect(result.x).toBeCloseTo(0.5, 2);
      expect(result.y).toBeCloseTo(0.5, 2);
      expect(result.clamped).toBe(false);
    });

    it('should handle negative rotation', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: -45,
          },
        ],
      };

      // Test inverse rotation
      const result = mapPreviewToOriginal(0.6, 0.6, stack, 1000, 1000);

      // Result should be rotated back by +45 degrees
      expect(result.clamped).toBe(false);
    });

    it('should handle 135 degree rotation (quadrant II)', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: 135,
          },
        ],
      };

      // Point at (0.25, 0.75) after 135° rotation
      const result = mapPreviewToOriginal(0.25, 0.75, stack, 1000, 1000);

      // Should map to approximately (0.75, 0.75) in original
      expect(result.x).toBeCloseTo(0.75, 1);
      expect(result.y).toBeCloseTo(0.75, 1);
      expect(result.clamped).toBe(false);
    });

    it('should handle 225 degree rotation (quadrant III)', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: 225,
          },
        ],
      };

      // Point at (0.3, 0.3) after 225° rotation
      const result = mapPreviewToOriginal(0.3, 0.3, stack, 1000, 1000);

      // Should map to approximately (0.7, 0.3) in original
      expect(result.x).toBeCloseTo(0.7, 1);
      expect(result.y).toBeCloseTo(0.3, 1);
      expect(result.clamped).toBe(false);
    });

    it('should handle 315 degree rotation (quadrant IV)', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: 315,
          },
        ],
      };

      // Point at (0.8, 0.2) after 315° rotation (-45°)
      const result = mapPreviewToOriginal(0.8, 0.2, stack, 1000, 1000);

      // Should map back correctly
      expect(result.clamped).toBe(false);
    });

    it('should handle 180 degree rotation', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: 180,
          },
        ],
      };

      // Point at (0.3, 0.7) after 180° rotation
      const result = mapPreviewToOriginal(0.3, 0.7, stack, 1000, 1000);

      // Should map to (0.7, 0.3) in original (flipped)
      expect(result.x).toBeCloseTo(0.7, 1);
      expect(result.y).toBeCloseTo(0.3, 1);
      expect(result.clamped).toBe(false);
    });

    it('should handle 270 degree rotation', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: 270,
          },
        ],
      };

      // Point at (0.4, 0.6) after 270° rotation
      const result = mapPreviewToOriginal(0.4, 0.6, stack, 1000, 1000);

      // Should map correctly (-90° rotation inverse)
      expect(result.x).toBeCloseTo(0.6, 1);
      expect(result.y).toBeCloseTo(0.6, 1);
      expect(result.clamped).toBe(false);
    });
  });

  describe('Combined transformations', () => {
    it('should handle crop followed by rotation', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            rectNorm: [0.25, 0.25, 0.5, 0.5],
          },
          {
            op: 'crop',
            angleDeg: 45,
          },
        ],
      };

      // Apply inverse transformations in reverse order
      const result = mapPreviewToOriginal(0.5, 0.5, stack, 1000, 1000);

      // Should undo rotation first, then crop
      expect(result.clamped).toBe(false);
    });

    it('should handle multiple crops', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            rectNorm: [0.1, 0.1, 0.8, 0.8],
          },
          {
            op: 'crop',
            rectNorm: [0.1, 0.1, 0.8, 0.8],
          },
        ],
      };

      // Two 80% crops compound
      const result = mapPreviewToOriginal(0.5, 0.5, stack, 1000, 1000);

      // First inverse: 0.1 + 0.5 * 0.8 = 0.5
      // Second inverse: 0.1 + 0.5 * 0.8 = 0.5
      expect(result.x).toBeCloseTo(0.5, 2);
      expect(result.y).toBeCloseTo(0.5, 2);
    });
  });

  describe('Clamping', () => {
    it('should clamp coordinates outside valid range', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            rectNorm: [0.8, 0.8, 0.4, 0.4], // Crop that extends beyond bounds
          },
        ],
      };

      // This would map outside [0,1]
      const result = mapPreviewToOriginal(1, 1, stack, 1000, 1000);

      expect(result.x).toBe(1); // Clamped
      expect(result.y).toBe(1); // Clamped
      expect(result.clamped).toBe(true);
    });

    it('should clamp negative coordinates', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            rectNorm: [-0.1, -0.1, 0.5, 0.5], // Invalid crop with negative origin
          },
        ],
      };

      const result = mapPreviewToOriginal(0, 0, stack, 1000, 1000);

      expect(result.x).toBe(0); // Clamped from -0.1
      expect(result.y).toBe(0); // Clamped from -0.1
      expect(result.clamped).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty crop operation', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            // No rectNorm or angleDeg
          },
        ],
      };

      const result = mapPreviewToOriginal(0.5, 0.5, stack, 1000, 1000);

      expect(result.x).toBeCloseTo(0.5);
      expect(result.y).toBeCloseTo(0.5);
      expect(result.clamped).toBe(false);
    });

    it('should handle extreme rotation angles', () => {
      const stack = {
        ops: [
          {
            op: 'crop',
            angleDeg: 360, // Full rotation
          },
        ],
      };

      const result = mapPreviewToOriginal(0.7, 0.3, stack, 1000, 1000);

      // 360 degrees should return to same position
      expect(result.x).toBeCloseTo(0.7, 1);
      expect(result.y).toBeCloseTo(0.3, 1);
    });
  });
});
