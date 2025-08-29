import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { applySaturation, applyVibrance } from '../../src/imageProcessing';
import { SaturationOp, VibranceOp } from '../../src/editStack';

describe('Saturation operations', () => {
  describe('applySaturation', () => {
    it('should not change gray pixels', async () => {
      // Create a gray test image (128, 128, 128)
      const testBuffer = Buffer.alloc(3 * 3 * 3); // 3x3 RGB image
      for (let i = 0; i < testBuffer.length; i += 3) {
        testBuffer[i] = 128;     // R
        testBuffer[i + 1] = 128; // G
        testBuffer[i + 2] = 128; // B
      }
      
      const pipeline = sharp(testBuffer, {
        raw: {
          width: 3,
          height: 3,
          channels: 3
        }
      });
      
      const op: SaturationOp = {
        id: 'test_sat',
        op: 'saturation',
        amt: 50 // Increase saturation by 50%
      };
      
      const result = applySaturation(pipeline, op);
      const output = await result.raw().toBuffer();
      
      // Gray pixels should remain gray
      for (let i = 0; i < output.length; i += 3) {
        const r = output[i];
        const g = output[i + 1];
        const b = output[i + 2];
        
        // Allow small rounding differences
        expect(Math.abs(r - g)).toBeLessThan(2);
        expect(Math.abs(g - b)).toBeLessThan(2);
        expect(Math.abs(r - 128)).toBeLessThan(5);
      }
    });
    
    it('should increase color intensity with positive amount', async () => {
      // Create a colored test image (red)
      const testBuffer = Buffer.alloc(3 * 3 * 3);
      for (let i = 0; i < testBuffer.length; i += 3) {
        testBuffer[i] = 200;     // R
        testBuffer[i + 1] = 100; // G
        testBuffer[i + 2] = 100; // B
      }
      
      const pipeline = sharp(testBuffer, {
        raw: {
          width: 3,
          height: 3,
          channels: 3
        }
      });
      
      const op: SaturationOp = {
        id: 'test_sat',
        op: 'saturation',
        amt: 50
      };
      
      const result = applySaturation(pipeline, op);
      const output = await result.raw().toBuffer();
      
      // Check that saturation increased (more color difference)
      const r = output[0];
      const g = output[1];
      const b = output[2];
      
      // Red should be more dominant after saturation increase
      expect(r - g).toBeGreaterThan(100 - 50); // Original difference was 100
      expect(r - b).toBeGreaterThan(100 - 50);
    });
    
    it('should decrease color intensity with negative amount', async () => {
      // Create a colored test image (blue)
      const testBuffer = Buffer.alloc(3 * 3 * 3);
      for (let i = 0; i < testBuffer.length; i += 3) {
        testBuffer[i] = 100;     // R
        testBuffer[i + 1] = 100; // G
        testBuffer[i + 2] = 200; // B
      }
      
      const pipeline = sharp(testBuffer, {
        raw: {
          width: 3,
          height: 3,
          channels: 3
        }
      });
      
      const op: SaturationOp = {
        id: 'test_sat',
        op: 'saturation',
        amt: -50 // Decrease saturation
      };
      
      const result = applySaturation(pipeline, op);
      const output = await result.raw().toBuffer();
      
      // Check that saturation decreased (less color difference)
      const r = output[0];
      const g = output[1];
      const b = output[2];
      
      // Blue should be less dominant after saturation decrease
      expect(b - r).toBeLessThan(100); // Original difference was 100
      expect(b - g).toBeLessThan(100);
    });
    
    it('should fully desaturate with -100 amount', async () => {
      // Create a colored test image
      const testBuffer = Buffer.alloc(3 * 3 * 3);
      for (let i = 0; i < testBuffer.length; i += 3) {
        testBuffer[i] = 255;     // R
        testBuffer[i + 1] = 0;   // G
        testBuffer[i + 2] = 128; // B
      }
      
      const pipeline = sharp(testBuffer, {
        raw: {
          width: 3,
          height: 3,
          channels: 3
        }
      });
      
      const op: SaturationOp = {
        id: 'test_sat',
        op: 'saturation',
        amt: -100 // Full desaturation (grayscale)
      };
      
      const result = applySaturation(pipeline, op);
      const output = await result.raw().toBuffer();
      
      // Should be grayscale
      for (let i = 0; i < output.length; i += 3) {
        const r = output[i];
        const g = output[i + 1];
        const b = output[i + 2];
        
        // All channels should be equal (grayscale)
        expect(Math.abs(r - g)).toBeLessThan(2);
        expect(Math.abs(g - b)).toBeLessThan(2);
      }
    });
  });
  
  describe('applyVibrance', () => {
    it('should affect low-saturation colors more than high-saturation', async () => {
      // Create test image with varying saturation
      const testBuffer = Buffer.alloc(6 * 3); // 2 pixels
      
      // Pixel 1: Low saturation (pale pink)
      testBuffer[0] = 180;  // R
      testBuffer[1] = 150;  // G
      testBuffer[2] = 150;  // B
      
      // Pixel 2: High saturation (vivid red)
      testBuffer[3] = 255;  // R
      testBuffer[4] = 0;    // G
      testBuffer[5] = 0;    // B
      
      const pipeline = sharp(testBuffer, {
        raw: {
          width: 2,
          height: 1,
          channels: 3
        }
      });
      
      const op: VibranceOp = {
        id: 'test_vib',
        op: 'vibrance',
        amt: 50
      };
      
      const result = await applyVibrance(pipeline, op);
      const output = await result.raw().toBuffer();
      
      // Calculate saturation change for low-sat pixel
      const lowSatOrigDiff = 180 - 150; // 30
      const lowSatNewDiff = output[0] - output[1];
      const lowSatChange = lowSatNewDiff - lowSatOrigDiff;
      
      // Calculate saturation change for high-sat pixel
      const highSatOrigDiff = 255 - 0; // 255
      const highSatNewDiff = output[3] - output[4];
      const highSatChange = Math.abs(highSatNewDiff - highSatOrigDiff);
      
      // Low saturation pixel should change more than high saturation
      expect(lowSatChange).toBeGreaterThan(0);
      expect(highSatChange).toBeLessThan(lowSatChange);
    });
    
    it('should preserve gray pixels', async () => {
      // Create a gray test image
      const testBuffer = Buffer.alloc(3 * 3 * 3);
      for (let i = 0; i < testBuffer.length; i += 3) {
        testBuffer[i] = 128;     // R
        testBuffer[i + 1] = 128; // G
        testBuffer[i + 2] = 128; // B
      }
      
      const pipeline = sharp(testBuffer, {
        raw: {
          width: 3,
          height: 3,
          channels: 3
        }
      });
      
      const op: VibranceOp = {
        id: 'test_vib',
        op: 'vibrance',
        amt: 75 // High vibrance adjustment
      };
      
      const result = await applyVibrance(pipeline, op);
      const output = await result.raw().toBuffer();
      
      // Gray pixels should remain gray
      for (let i = 0; i < output.length; i += 3) {
        const r = output[i];
        const g = output[i + 1];
        const b = output[i + 2];
        
        expect(Math.abs(r - g)).toBeLessThan(2);
        expect(Math.abs(g - b)).toBeLessThan(2);
        expect(Math.abs(r - 128)).toBeLessThan(5);
      }
    });
  });
});