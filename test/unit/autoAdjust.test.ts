import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { autoWhiteBalance, autoExposure, autoContrast } from '../../src/autoAdjust';

describe('Auto adjustments', () => {
  let testImagePath: string;

  beforeAll(async () => {
    // Create a test image with known characteristics
    testImagePath = path.join(process.cwd(), 'test-auto-adjust.jpg');

    // Create a test image with a gray patch and varying brightness
    const width = 100;
    const height = 100;
    const buffer = Buffer.alloc(width * height * 3);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;

        if (x < 33) {
          // Left third: gray with blue cast
          buffer[idx] = 100; // R
          buffer[idx + 1] = 100; // G
          buffer[idx + 2] = 140; // B (blue cast)
        } else if (x < 66) {
          // Middle third: neutral gray
          buffer[idx] = 128; // R
          buffer[idx + 1] = 128; // G
          buffer[idx + 2] = 128; // B
        } else {
          // Right third: varying brightness
          const brightness = Math.floor((y / height) * 255);
          buffer[idx] = brightness; // R
          buffer[idx + 1] = brightness; // G
          buffer[idx + 2] = brightness; // B
        }
      }
    }

    await sharp(buffer, {
      raw: {
        width,
        height,
        channels: 3,
      },
    })
      .jpeg()
      .toFile(testImagePath);
  });

  describe('autoWhiteBalance', () => {
    it('should detect and correct color cast', async () => {
      const wbOp = await autoWhiteBalance(testImagePath);

      expect(wbOp.op).toBe('white_balance');
      expect(wbOp.method).toBe('temp_tint');

      // Should detect the blue cast and suggest warming
      if (wbOp.temp !== undefined) {
        expect(wbOp.temp).toBeGreaterThan(0); // Positive temp to warm up (reduce blue)
      }
    });

    it('should return clamped values', async () => {
      const wbOp = await autoWhiteBalance(testImagePath);

      if (wbOp.temp !== undefined) {
        expect(wbOp.temp).toBeGreaterThanOrEqual(-100);
        expect(wbOp.temp).toBeLessThanOrEqual(100);
      }

      if (wbOp.tint !== undefined) {
        expect(wbOp.tint).toBeGreaterThanOrEqual(-100);
        expect(wbOp.tint).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('autoExposure', () => {
    it('should target correct median brightness', async () => {
      const evOp = await autoExposure(testImagePath);

      expect(evOp.op).toBe('exposure');
      expect(evOp.ev).toBeDefined();

      // EV should be within reasonable range
      expect(evOp.ev).toBeGreaterThanOrEqual(-1.5);
      expect(evOp.ev).toBeLessThanOrEqual(1.5);
    });

    it('should apply white balance before analyzing', async () => {
      const wbOp = await autoWhiteBalance(testImagePath);
      const evOp = await autoExposure(testImagePath, wbOp);

      expect(evOp.op).toBe('exposure');
      expect(evOp.ev).toBeDefined();
    });

    it('should handle dark images', async () => {
      // Create a dark test image
      const darkPath = path.join(process.cwd(), 'test-dark.jpg');
      const darkBuffer = Buffer.alloc(100 * 100 * 3);

      // Fill with dark values
      for (let i = 0; i < darkBuffer.length; i++) {
        darkBuffer[i] = 30; // Very dark
      }

      await sharp(darkBuffer, {
        raw: {
          width: 100,
          height: 100,
          channels: 3,
        },
      })
        .jpeg()
        .toFile(darkPath);

      const evOp = await autoExposure(darkPath);

      // Should suggest positive EV to brighten
      expect(evOp.ev).toBeGreaterThan(0);

      // Clean up
      await fs.unlink(darkPath);
    });
  });

  describe('autoContrast', () => {
    it('should detect low contrast and suggest increase', async () => {
      // Create a low contrast test image
      const lowContrastPath = path.join(process.cwd(), 'test-low-contrast.jpg');
      const buffer = Buffer.alloc(100 * 100 * 3);

      // Fill with narrow range of values (low contrast)
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = 100 + Math.floor(Math.random() * 30); // Values between 100-130
      }

      await sharp(buffer, {
        raw: {
          width: 100,
          height: 100,
          channels: 3,
        },
      })
        .jpeg()
        .toFile(lowContrastPath);

      const contrastOp = await autoContrast(lowContrastPath);

      expect(contrastOp.op).toBe('contrast');
      expect(contrastOp.amt).toBeDefined();

      // Should suggest positive contrast to increase range
      expect(contrastOp.amt).toBeGreaterThan(0);

      // Clean up
      await fs.unlink(lowContrastPath);
    });

    it('should respect clamp limits', async () => {
      const contrastOp = await autoContrast(testImagePath);

      expect(contrastOp.amt).toBeGreaterThanOrEqual(-40);
      expect(contrastOp.amt).toBeLessThanOrEqual(40);
    });

    it('should apply WB and EV before analyzing', async () => {
      const wbOp = await autoWhiteBalance(testImagePath);
      const evOp = await autoExposure(testImagePath, wbOp);
      const contrastOp = await autoContrast(testImagePath, wbOp, evOp);

      expect(contrastOp.op).toBe('contrast');
      expect(contrastOp.amt).toBeDefined();
    });
  });

  // Clean up test image after all tests
  afterAll(async () => {
    try {
      await fs.unlink(testImagePath);
    } catch (e) {
      // Ignore if already deleted
    }
  });
});
