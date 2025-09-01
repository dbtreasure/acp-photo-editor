import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { computeHistogram, generateSparkline, formatHistogramDisplay } from '../../src/histogram';
import { EditStack } from '../../src/editStack';

describe('Histogram computation', () => {
  let testImagePath: string;
  let clippedImagePath: string;

  beforeAll(async () => {
    // Create a test image with known histogram characteristics
    testImagePath = path.join(process.cwd(), 'test-histogram.jpg');

    const width = 100;
    const height = 100;
    const buffer = Buffer.alloc(width * height * 3);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;

        // Create gradient from black to white
        const value = Math.floor((x / width) * 255);
        buffer[idx] = value; // R
        buffer[idx + 1] = value; // G
        buffer[idx + 2] = value; // B
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

    // Create a test image with clipping
    clippedImagePath = path.join(process.cwd(), 'test-clipped.jpg');

    const clippedBuffer = Buffer.alloc(width * height * 3);
    for (let i = 0; i < clippedBuffer.length; i += 3) {
      if (i < clippedBuffer.length / 3) {
        // First third: black (clipped low)
        clippedBuffer[i] = 0;
        clippedBuffer[i + 1] = 0;
        clippedBuffer[i + 2] = 0;
      } else if (i < (2 * clippedBuffer.length) / 3) {
        // Middle third: mid gray
        clippedBuffer[i] = 128;
        clippedBuffer[i + 1] = 128;
        clippedBuffer[i + 2] = 128;
      } else {
        // Last third: white (clipped high)
        clippedBuffer[i] = 255;
        clippedBuffer[i + 1] = 255;
        clippedBuffer[i + 2] = 255;
      }
    }

    await sharp(clippedBuffer, {
      raw: {
        width,
        height,
        channels: 3,
      },
    })
      .jpeg()
      .toFile(clippedImagePath);
  });

  describe('computeHistogram', () => {
    it('should return histogram with correct structure', async () => {
      const editStack: EditStack = {
        version: 1,
        baseUri: 'file://' + testImagePath,
        ops: [],
      };

      const histogram = await computeHistogram(testImagePath, editStack);

      expect(histogram).toHaveProperty('hist');
      expect(histogram.hist).toHaveProperty('luma');
      expect(histogram.hist).toHaveProperty('r');
      expect(histogram.hist).toHaveProperty('g');
      expect(histogram.hist).toHaveProperty('b');
      expect(histogram.hist).toHaveProperty('clip');

      expect(histogram.hist.luma).toHaveLength(64);
      expect(histogram.hist.r).toHaveLength(64);
      expect(histogram.hist.g).toHaveLength(64);
      expect(histogram.hist.b).toHaveLength(64);

      expect(histogram.hist.clip).toHaveProperty('lowPct');
      expect(histogram.hist.clip).toHaveProperty('highPct');
    });

    it('should detect clipping correctly', async () => {
      const editStack: EditStack = {
        version: 1,
        baseUri: 'file://' + clippedImagePath,
        ops: [],
      };

      const histogram = await computeHistogram(clippedImagePath, editStack);

      // Approximately 33% should be clipped low
      expect(histogram.hist.clip.lowPct).toBeGreaterThan(30);
      expect(histogram.hist.clip.lowPct).toBeLessThan(40);

      // Approximately 33% should be clipped high
      expect(histogram.hist.clip.highPct).toBeGreaterThan(30);
      expect(histogram.hist.clip.highPct).toBeLessThan(40);
    });

    it('should apply edit stack before computing histogram', async () => {
      const editStack: EditStack = {
        version: 1,
        baseUri: 'file://' + testImagePath,
        ops: [
          {
            id: 'test_contrast',
            op: 'contrast',
            amt: 50, // Increase contrast
          },
        ],
      };

      const histogramBefore = await computeHistogram(testImagePath, {
        version: 1,
        baseUri: 'file://' + testImagePath,
        ops: [],
      });

      const histogramAfter = await computeHistogram(testImagePath, editStack);

      // Contrast should spread the histogram
      // The middle bins should have less data after contrast increase
      const middleBinBefore = histogramBefore.hist.luma[32];
      const middleBinAfter = histogramAfter.hist.luma[32];

      expect(middleBinAfter).not.toEqual(middleBinBefore);
    });

    it('should normalize histogram values to 0-100', async () => {
      const editStack: EditStack = {
        version: 1,
        baseUri: 'file://' + testImagePath,
        ops: [],
      };

      const histogram = await computeHistogram(testImagePath, editStack);

      // All values should be between 0 and 100
      for (const bin of histogram.hist.luma) {
        expect(bin).toBeGreaterThanOrEqual(0);
        expect(bin).toBeLessThanOrEqual(100);
      }

      // At least one bin should be 100 (the max)
      expect(Math.max(...histogram.hist.luma)).toBe(100);
    });
  });

  describe('generateSparkline', () => {
    it('should generate sparkline with correct length', () => {
      const data = new Array(64).fill(0).map((_, i) => i);
      const sparkline = generateSparkline(data);

      expect(sparkline).toHaveLength(64);
    });

    it('should use appropriate spark characters', () => {
      const data = [0, 25, 50, 75, 100];
      const sparkline = generateSparkline(data);

      // Should use different characters for different values
      expect(sparkline[0]).toBe(' '); // Lowest
      expect(sparkline[4]).toBe('█'); // Highest
    });

    it('should handle empty data', () => {
      const sparkline = generateSparkline([]);
      expect(sparkline).toBe('');
    });

    it('should handle uniform data', () => {
      const data = new Array(10).fill(50);
      const sparkline = generateSparkline(data);

      // All characters should be the same
      const firstChar = sparkline[0];
      for (const char of sparkline) {
        expect(char).toBe(firstChar);
      }
    });
  });

  describe('formatHistogramDisplay', () => {
    it('should format histogram data as text display', async () => {
      const editStack: EditStack = {
        version: 1,
        baseUri: 'file://' + testImagePath,
        ops: [],
      };

      const histogram = await computeHistogram(testImagePath, editStack);
      const display = formatHistogramDisplay(histogram);

      expect(display).toContain('Histogram:');
      expect(display).toContain('Luma:');
      expect(display).toContain('Red:');
      expect(display).toContain('Green:');
      expect(display).toContain('Blue:');
      expect(display).toContain('Clipping:');
      expect(display).toContain('Low');
      expect(display).toContain('High');
    });

    it('should include sparklines for each channel', async () => {
      const editStack: EditStack = {
        version: 1,
        baseUri: 'file://' + testImagePath,
        ops: [],
      };

      const histogram = await computeHistogram(testImagePath, editStack);
      const display = formatHistogramDisplay(histogram);

      const lines = display.split('\n');

      // Find the luma line and check it has a sparkline
      const lumaLine = lines.find((l) => l.includes('Luma:'));
      expect(lumaLine).toBeDefined();
      expect(lumaLine!.length).toBeGreaterThan(10); // Should have sparkline characters
    });
  });

  // Clean up test images after all tests
  afterAll(async () => {
    try {
      await fs.unlink(testImagePath);
      await fs.unlink(clippedImagePath);
    } catch (e) {
      // Ignore if already deleted
    }
  });
});
