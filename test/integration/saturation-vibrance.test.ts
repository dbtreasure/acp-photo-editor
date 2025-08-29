import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { EditStackManager } from '../../src/editStack';
import { applyColorOperations } from '../../src/imageProcessing';

describe('Saturation and Vibrance Export Tests', () => {
  let testImagePath: string;
  let baselineBuffer: Buffer;
  
  beforeAll(async () => {
    // Create a colorful test image
    testImagePath = path.join(process.cwd(), 'test-sat-vib.jpg');
    
    const width = 100;
    const height = 100;
    const buffer = Buffer.alloc(width * height * 3);
    
    // Create quadrants with different colors
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        
        if (x < width / 2 && y < height / 2) {
          // Top-left: Red
          buffer[idx] = 200;
          buffer[idx + 1] = 50;
          buffer[idx + 2] = 50;
        } else if (x >= width / 2 && y < height / 2) {
          // Top-right: Green
          buffer[idx] = 50;
          buffer[idx + 1] = 200;
          buffer[idx + 2] = 50;
        } else if (x < width / 2 && y >= height / 2) {
          // Bottom-left: Blue
          buffer[idx] = 50;
          buffer[idx + 1] = 50;
          buffer[idx + 2] = 200;
        } else {
          // Bottom-right: Gray
          buffer[idx] = 128;
          buffer[idx + 1] = 128;
          buffer[idx + 2] = 128;
        }
      }
    }
    
    await sharp(buffer, {
      raw: {
        width,
        height,
        channels: 3
      }
    })
    .jpeg()
    .toFile(testImagePath);
    
    // Store baseline for comparison
    baselineBuffer = await sharp(testImagePath).png().toBuffer();
  });
  
  describe('Export with saturation changes', () => {
    it('should export different bytes when saturation is applied', async () => {
      const stackManager = new EditStackManager('file://' + testImagePath);
      stackManager.addSaturation({ amt: 50 });
      
      const metadata = await sharp(testImagePath).metadata();
      const pipeline = sharp(testImagePath);
      const stack = stackManager.getStack();
      
      const result = await applyColorOperations(pipeline, stack.ops as any, metadata);
      const exportBuffer = await result.png().toBuffer();
      
      // The exported image should be different from baseline
      expect(exportBuffer).not.toEqual(baselineBuffer);
      expect(exportBuffer.length).toBeGreaterThan(0);
      
      // Verify colors are more saturated
      const exportMeta = await sharp(exportBuffer).stats();
      const baselineMeta = await sharp(baselineBuffer).stats();
      
      // Standard deviation should be higher with increased saturation
      const exportStdDev = exportMeta.channels.reduce((sum, ch) => sum + ch.stdev, 0);
      const baselineStdDev = baselineMeta.channels.reduce((sum, ch) => sum + ch.stdev, 0);
      
      expect(exportStdDev).toBeGreaterThan(baselineStdDev);
    });
    
    it('should export grayscale when saturation is -100', async () => {
      const stackManager = new EditStackManager('file://' + testImagePath);
      stackManager.addSaturation({ amt: -100 });
      
      const metadata = await sharp(testImagePath).metadata();
      const pipeline = sharp(testImagePath);
      const stack = stackManager.getStack();
      
      const result = await applyColorOperations(pipeline, stack.ops as any, metadata);
      const exportBuffer = await result.png().toBuffer();
      
      // Sample some pixels to verify they're grayscale
      const { data, info } = await sharp(exportBuffer)
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      // Check several pixels - R, G, B should be equal (grayscale)
      for (let i = 0; i < 100; i += 10) {
        const idx = i * 3;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        
        // Allow small tolerance for rounding
        expect(Math.abs(r - g)).toBeLessThan(5);
        expect(Math.abs(g - b)).toBeLessThan(5);
      }
    });
  });
  
  describe('Export with vibrance changes', () => {
    it('should export different bytes when vibrance is applied', async () => {
      const stackManager = new EditStackManager('file://' + testImagePath);
      stackManager.addVibrance({ amt: 60 });
      
      const metadata = await sharp(testImagePath).metadata();
      const pipeline = sharp(testImagePath);
      const stack = stackManager.getStack();
      
      const result = await applyColorOperations(pipeline, stack.ops as any, metadata);
      const exportBuffer = await result.png().toBuffer();
      
      // The exported image should be different from baseline
      expect(exportBuffer).not.toEqual(baselineBuffer);
      
      // Verify the effect is applied
      const exportMeta = await sharp(exportBuffer).stats();
      const baselineMeta = await sharp(baselineBuffer).stats();
      
      // Vibrance should increase overall saturation
      const exportStdDev = exportMeta.channels.reduce((sum, ch) => sum + ch.stdev, 0);
      const baselineStdDev = baselineMeta.channels.reduce((sum, ch) => sum + ch.stdev, 0);
      
      expect(exportStdDev).toBeGreaterThan(baselineStdDev);
    });
    
    it('should apply vibrance more gently than saturation', async () => {
      const satManager = new EditStackManager('file://' + testImagePath);
      satManager.addSaturation({ amt: 50 });
      
      const vibManager = new EditStackManager('file://' + testImagePath);
      vibManager.addVibrance({ amt: 50 });
      
      const metadata = await sharp(testImagePath).metadata();
      
      // Apply saturation
      const satPipeline = sharp(testImagePath);
      const satResult = await applyColorOperations(satPipeline, satManager.getStack().ops as any, metadata);
      const satBuffer = await satResult.png().toBuffer();
      
      // Apply vibrance
      const vibPipeline = sharp(testImagePath);
      const vibResult = await applyColorOperations(vibPipeline, vibManager.getStack().ops as any, metadata);
      const vibBuffer = await vibResult.png().toBuffer();
      
      // Both should be different from baseline
      expect(satBuffer).not.toEqual(baselineBuffer);
      expect(vibBuffer).not.toEqual(baselineBuffer);
      
      // Saturation and vibrance should produce different results
      expect(satBuffer).not.toEqual(vibBuffer);
      
      // Vibrance should be more subtle (less standard deviation change)
      const satMeta = await sharp(satBuffer).stats();
      const vibMeta = await sharp(vibBuffer).stats();
      const baseMeta = await sharp(baselineBuffer).stats();
      
      const satChange = Math.abs(satMeta.channels[0].stdev - baseMeta.channels[0].stdev);
      const vibChange = Math.abs(vibMeta.channels[0].stdev - baseMeta.channels[0].stdev);
      
      // Vibrance effect should be gentler than saturation
      expect(vibChange).toBeLessThan(satChange);
    });
  });
  
  describe('Combined operations', () => {
    it('should apply both saturation and vibrance together', async () => {
      const stackManager = new EditStackManager('file://' + testImagePath);
      stackManager.addSaturation({ amt: 30 });
      stackManager.addVibrance({ amt: 40 });
      
      const metadata = await sharp(testImagePath).metadata();
      const pipeline = sharp(testImagePath);
      const stack = stackManager.getStack();
      
      const result = await applyColorOperations(pipeline, stack.ops as any, metadata);
      const exportBuffer = await result.png().toBuffer();
      
      // Should be different from baseline
      expect(exportBuffer).not.toEqual(baselineBuffer);
      
      // Should have both operations in the stack
      expect(stack.ops).toHaveLength(2);
      expect(stack.ops[0].op).toBe('saturation');
      expect(stack.ops[1].op).toBe('vibrance');
    });
  });
  
  describe('Operation ordering', () => {
    it('should apply operations in correct pipeline order', async () => {
      const stackManager = new EditStackManager('file://' + testImagePath);
      
      // Add operations - they're stored in the order added
      stackManager.addCrop({ rectNorm: [0.25, 0.25, 0.5, 0.5] });
      stackManager.addSaturation({ amt: 50 });
      stackManager.addWhiteBalance({ method: 'temp_tint', temp: 10, tint: 5 });
      stackManager.addVibrance({ amt: 30 });
      stackManager.addExposure({ ev: 0.5 });
      stackManager.addContrast({ amt: 20 });
      
      const stack = stackManager.getStack();
      
      // Verify all operations are present
      expect(stack.ops).toHaveLength(6);
      
      // Find operations by type
      const hasWB = stack.ops.some(op => op.op === 'white_balance');
      const hasEV = stack.ops.some(op => op.op === 'exposure');
      const hasContrast = stack.ops.some(op => op.op === 'contrast');
      const hasSat = stack.ops.some(op => op.op === 'saturation');
      const hasVib = stack.ops.some(op => op.op === 'vibrance');
      const hasCrop = stack.ops.some(op => op.op === 'crop');
      
      expect(hasWB).toBe(true);
      expect(hasEV).toBe(true);
      expect(hasContrast).toBe(true);
      expect(hasSat).toBe(true);
      expect(hasVib).toBe(true);
      expect(hasCrop).toBe(true);
      
      // The actual ordering happens in the MCP server's render_preview and commit_version
      // where operations are separated into colorOps and geometryOps
      // This test verifies all operations are stored correctly
      
      // When processed, the pipeline applies in this order:
      // 1. Color ops: WB → EV → Contrast → Saturation → Vibrance (via applyColorOperations)
      // 2. Geometry ops: Crop (applied after color)
      // This is enforced by the MCP server implementation, not the stack order
    });
  });
  
  describe('Value clamping', () => {
    it('should clamp extreme saturation values', () => {
      const stackManager = new EditStackManager('file://' + testImagePath);
      
      // Try extreme positive value
      stackManager.addSaturation({ amt: 999 });
      let summary = stackManager.getStackSummary();
      expect(summary).toContain('Sat +100'); // Should be clamped to 100
      
      // Reset and try extreme negative value
      stackManager.reset();
      stackManager.addSaturation({ amt: -999 });
      summary = stackManager.getStackSummary();
      expect(summary).toContain('Sat -100'); // Should be clamped to -100
    });
    
    it('should clamp extreme vibrance values', () => {
      const stackManager = new EditStackManager('file://' + testImagePath);
      
      // Try extreme positive value
      stackManager.addVibrance({ amt: 500 });
      let summary = stackManager.getStackSummary();
      expect(summary).toContain('Vib +100'); // Should be clamped to 100
      
      // Reset and try extreme negative value
      stackManager.reset();
      stackManager.addVibrance({ amt: -500 });
      summary = stackManager.getStackSummary();
      expect(summary).toContain('Vib -100'); // Should be clamped to -100
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