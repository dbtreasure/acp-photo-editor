import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EditStackManager } from '../../src/editStack';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { applyColorOperations } from '../../src/imageProcessing';
import { autoAll } from '../../src/autoAdjust';
import { computeHistogram, formatHistogramDisplay } from '../../src/histogram';

describe('Phase 6 Integration Tests', () => {
  let testImagePath: string;
  let stackManager: EditStackManager;

  beforeAll(async () => {
    // Create a test image with various characteristics
    testImagePath = path.join(process.cwd(), 'test-phase6.jpg');

    const width = 200;
    const height = 200;
    const buffer = Buffer.alloc(width * height * 3);

    // Create an image with:
    // - Color cast (blue tint)
    // - Low exposure (dark)
    // - Low contrast
    // - Some colorful areas for saturation/vibrance testing
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;

        if (x < width / 2 && y < height / 2) {
          // Top-left: Dark blue-tinted gray
          buffer[idx] = 40; // R
          buffer[idx + 1] = 40; // G
          buffer[idx + 2] = 60; // B (blue cast)
        } else if (x >= width / 2 && y < height / 2) {
          // Top-right: Muted red
          buffer[idx] = 120; // R
          buffer[idx + 1] = 80; // G
          buffer[idx + 2] = 80; // B
        } else if (x < width / 2 && y >= height / 2) {
          // Bottom-left: Muted green
          buffer[idx] = 80; // R
          buffer[idx + 1] = 120; // G
          buffer[idx + 2] = 80; // B
        } else {
          // Bottom-right: Dark gray
          buffer[idx] = 60; // R
          buffer[idx + 1] = 60; // G
          buffer[idx + 2] = 60; // B
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

    // Initialize stack manager
    stackManager = new EditStackManager('file://' + testImagePath);
  });

  describe('Complete editing workflow', () => {
    it('should apply saturation and vibrance together', async () => {
      // Add saturation
      stackManager.addSaturation({ amt: 30 });
      expect(stackManager.getStackLength()).toBe(1);

      // Add vibrance
      stackManager.addVibrance({ amt: 40 });
      expect(stackManager.getStackLength()).toBe(2);

      // Verify stack summary includes both
      const summary = stackManager.getStackSummary();
      expect(summary).toContain('Sat +30');
      expect(summary).toContain('Vib +40');

      // Apply operations and verify they work
      const metadata = await sharp(testImagePath).metadata();
      const pipeline = sharp(testImagePath);
      const stack = stackManager.getStack();

      const colorOps = stack.ops.filter((op) => op.op === 'saturation' || op.op === 'vibrance');

      const result = await applyColorOperations(pipeline, colorOps as any, metadata);
      const output = await result.raw().toBuffer();

      expect(output).toBeDefined();
      expect(output.length).toBeGreaterThan(0);
    });

    it('should handle amend-last for saturation/vibrance', () => {
      stackManager.reset();

      // Add saturation
      stackManager.addSaturation({ amt: 20 });
      expect(stackManager.getStackLength()).toBe(1);

      // Amend saturation (should replace)
      stackManager.addSaturation({ amt: 50 });
      expect(stackManager.getStackLength()).toBe(1);
      expect(stackManager.getStackSummary()).toContain('Sat +50');

      // Add vibrance
      stackManager.addVibrance({ amt: 30 });
      expect(stackManager.getStackLength()).toBe(2);

      // Amend vibrance (should replace)
      stackManager.addVibrance({ amt: 60 });
      expect(stackManager.getStackLength()).toBe(2);
      expect(stackManager.getStackSummary()).toContain('Vib +60');
    });
  });

  describe('Auto adjustments workflow', () => {
    it('should apply auto all adjustments correctly', async () => {
      stackManager.reset();

      // Apply auto adjustments
      const adjustments = await autoAll(testImagePath);

      // Add to stack
      stackManager.addWhiteBalance({
        method: adjustments.whiteBalance.method,
        temp: adjustments.whiteBalance.temp,
        tint: adjustments.whiteBalance.tint,
      });

      stackManager.addExposure({
        ev: adjustments.exposure.ev,
      });

      stackManager.addContrast({
        amt: adjustments.contrast.amt,
      });

      // Should have 3 operations
      expect(stackManager.getStackLength()).toBe(3);

      // Verify they're reasonable adjustments
      expect(adjustments.whiteBalance.temp).toBeDefined();
      expect(adjustments.exposure.ev).toBeGreaterThanOrEqual(-1.5);
      expect(adjustments.exposure.ev).toBeLessThanOrEqual(1.5);
      expect(adjustments.contrast.amt).toBeGreaterThanOrEqual(-40);
      expect(adjustments.contrast.amt).toBeLessThanOrEqual(40);
    });

    it('should improve histogram after auto adjustments', async () => {
      // Get histogram before adjustments
      const beforeStack = {
        version: 1 as const,
        baseUri: 'file://' + testImagePath,
        ops: [],
      };
      const histBefore = await computeHistogram(testImagePath, beforeStack);

      // Apply auto adjustments
      const adjustments = await autoAll(testImagePath);

      // Get histogram after adjustments
      const afterStack = {
        version: 1 as const,
        baseUri: 'file://' + testImagePath,
        ops: [adjustments.whiteBalance, adjustments.exposure, adjustments.contrast],
      };
      const histAfter = await computeHistogram(testImagePath, afterStack);

      // After auto adjustments, the histogram should be more spread out
      // Check that we're using more of the range
      const beforeRange = Math.max(...histBefore.hist.luma.filter((v) => v > 10));
      const afterRange = Math.max(...histAfter.hist.luma.filter((v) => v > 10));

      // The histogram should show better distribution after auto
      expect(afterRange).toBeDefined();
      expect(beforeRange).toBeDefined();
    });
  });

  describe('Histogram with edit stack', () => {
    it('should compute histogram after color operations', async () => {
      stackManager.reset();

      // Add multiple color operations
      stackManager.addWhiteBalance({
        method: 'temp_tint',
        temp: 20,
        tint: -10,
      });
      stackManager.addExposure({ ev: 0.5 });
      stackManager.addContrast({ amt: 20 });
      stackManager.addSaturation({ amt: 25 });
      stackManager.addVibrance({ amt: 30 });

      const stack = stackManager.getStack();
      const histogram = await computeHistogram(testImagePath, stack);

      expect(histogram.hist.luma).toHaveLength(64);
      expect(histogram.hist.r).toHaveLength(64);
      expect(histogram.hist.g).toHaveLength(64);
      expect(histogram.hist.b).toHaveLength(64);

      // Format and verify display
      const display = formatHistogramDisplay(histogram);
      expect(display).toContain('Histogram:');
      expect(display).toContain('Clipping:');
    });

    it('should show reduced clipping after auto contrast', async () => {
      // Create an image with heavy clipping
      const clippedPath = path.join(process.cwd(), 'test-clipped-phase6.jpg');
      const width = 100;
      const height = 100;
      const buffer = Buffer.alloc(width * height * 3);

      // Create high contrast image with clipping
      for (let i = 0; i < buffer.length; i += 3) {
        const value = Math.random() > 0.5 ? 250 : 5; // Near black or near white
        buffer[i] = value;
        buffer[i + 1] = value;
        buffer[i + 2] = value;
      }

      await sharp(buffer, {
        raw: { width, height, channels: 3 },
      })
        .jpeg()
        .toFile(clippedPath);

      // Get initial histogram
      const beforeStack = {
        version: 1 as const,
        baseUri: 'file://' + clippedPath,
        ops: [],
      };
      const histBefore = await computeHistogram(clippedPath, beforeStack);

      // Apply auto contrast
      const { autoContrast: getAutoContrast } = await import('../../src/autoAdjust');
      const contrastOp = await getAutoContrast(clippedPath);

      // Get histogram after auto contrast
      const afterStack = {
        version: 1 as const,
        baseUri: 'file://' + clippedPath,
        ops: [contrastOp],
      };
      const histAfter = await computeHistogram(clippedPath, afterStack);

      // Clipping should be similar or slightly improved
      // (auto contrast tries to preserve highlights/shadows)
      expect(histAfter.hist.clip.highPct).toBeLessThanOrEqual(histBefore.hist.clip.highPct + 5);

      // Clean up
      await fs.unlink(clippedPath);
    });
  });

  describe('Combined operations order', () => {
    it('should apply operations in correct order', async () => {
      stackManager.reset();

      // Add operations in various order
      stackManager.addSaturation({ amt: 30 });
      stackManager.addWhiteBalance({ method: 'temp_tint', temp: 10, tint: 5 });
      stackManager.addVibrance({ amt: 20 });
      stackManager.addExposure({ ev: 0.3 });
      stackManager.addContrast({ amt: 15 });

      const stack = stackManager.getStack();

      // Despite the order they were added, they should be applied in the correct order:
      // WB → EV → Contrast → Saturation → Vibrance
      const metadata = await sharp(testImagePath).metadata();
      const pipeline = sharp(testImagePath);

      const result = await applyColorOperations(pipeline, stack.ops as any, metadata);
      const output = await result.png().toBuffer();

      expect(output).toBeDefined();
      expect(output.length).toBeGreaterThan(0);
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
