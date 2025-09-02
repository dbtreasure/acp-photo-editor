import { describe, it, expect } from 'vitest';
import { computeDeltas, areAllDeltasBelowEpsilon, formatDeltasForDisplay, deltasToPlannedCalls, ImageStats } from '../../src/deltaMapper';

describe('Phase 7e - Reference Look Match', () => {
  describe('Delta computation', () => {
    it('should compute white balance deltas from LAB differences', () => {
      const targetStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50, p95: 90, mean: 50, stdev: 20 },
        AB: { a_mean: 5, b_mean: -10, chroma_mean: 15 },
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 80,
      };
      
      const refStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50, p95: 90, mean: 50, stdev: 20 },
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10 },  // More neutral
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 80,
      };
      
      const deltas = computeDeltas(targetStats, refStats);
      
      // Target has positive a (magenta) and negative b (blue), ref is neutral
      // So we need negative temp adjustment (cooler) and positive tint (less green)
      expect(deltas.temp).toBeDefined();
      expect(deltas.temp! < 0).toBe(true); // Should cool down
      expect(deltas.tint).toBeDefined();
      expect(deltas.tint! > 0).toBe(true); // Should add magenta
    });
    
    it('should compute exposure delta from luminance differences', () => {
      const targetStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 10, p50: 30, p95: 70, mean: 35, stdev: 15 },  // Darker
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10 },
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 60,
      };
      
      const refStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 20, p50: 60, p95: 95, mean: 60, stdev: 20 },  // Brighter
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10 },
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 75,
      };
      
      const deltas = computeDeltas(targetStats, refStats);
      
      expect(deltas.ev).toBeDefined();
      expect(deltas.ev! > 0).toBe(true); // Should brighten
      expect(deltas.ev!).toBeCloseTo((60 - 30) / 12, 1); // Approximately
    });
    
    it('should compute contrast delta from luminance range differences', () => {
      const targetStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 30, p50: 50, p95: 70, mean: 50, stdev: 10 },  // Low contrast (40 range)
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10 },
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 40,
      };
      
      const refStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50, p95: 90, mean: 50, stdev: 25 },  // High contrast (80 range)
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10 },
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 80,
      };
      
      const deltas = computeDeltas(targetStats, refStats);
      
      expect(deltas.contrast).toBeDefined();
      expect(deltas.contrast! > 0).toBe(true); // Should increase contrast
    });
    
    it('should split colorfulness delta between vibrance and saturation', () => {
      const targetStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50, p95: 90, mean: 50, stdev: 20 },
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10 },
        sat: { hsv_mean: 20, hsv_p95: 40, colorfulness: 15 },  // Muted
        contrast_index: 80,
      };
      
      const refStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50, p95: 90, mean: 50, stdev: 20 },
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 20 },
        sat: { hsv_mean: 50, hsv_p95: 80, colorfulness: 45 },  // Vibrant
        contrast_index: 80,
      };
      
      const deltas = computeDeltas(targetStats, refStats);
      
      expect(deltas.vibrance).toBeDefined();
      expect(deltas.saturation).toBeDefined();
      expect(deltas.vibrance! > 0).toBe(true);
      expect(deltas.saturation! > 0).toBe(true);
      // Vibrance should get 70% of the adjustment
      expect(Math.abs(deltas.vibrance!) > Math.abs(deltas.saturation!)).toBe(true);
    });
    
    it('should detect aspect ratio differences', () => {
      const targetStats: ImageStats = {
        w: 1000,
        h: 800,  // 5:4 aspect
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50, p95: 90, mean: 50, stdev: 20 },
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10 },
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 80,
      };
      
      const refStats: ImageStats = {
        w: 1000,
        h: 1000,  // 1:1 aspect (square)
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50, p95: 90, mean: 50, stdev: 20 },
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10 },
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 80,
      };
      
      const deltas = computeDeltas(targetStats, refStats);
      
      expect(deltas.aspect).toBe('1:1');
    });
  });
  
  describe('Epsilon suppression', () => {
    it('should suppress tiny deltas below epsilon thresholds', () => {
      const targetStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50, p95: 90, mean: 50, stdev: 20 },
        AB: { a_mean: 0.5, b_mean: -0.5, chroma_mean: 10 },  // Tiny differences
        sat: { hsv_mean: 30, hsv_p95: 60, colorfulness: 25 },
        contrast_index: 80,
      };
      
      const refStats: ImageStats = {
        w: 1000,
        h: 800,
        mime: 'image/jpeg',
        L: { p5: 10, p50: 50.5, p95: 90.5, mean: 50.5, stdev: 20 },  // Very close
        AB: { a_mean: 0, b_mean: 0, chroma_mean: 10.5 },
        sat: { hsv_mean: 31, hsv_p95: 61, colorfulness: 26 },
        contrast_index: 81,
      };
      
      const deltas = computeDeltas(targetStats, refStats);
      
      // All deltas should be suppressed as they're below epsilon
      expect(deltas.temp).toBeUndefined();
      expect(deltas.tint).toBeUndefined();
      expect(deltas.ev).toBeUndefined();
      expect(deltas.contrast).toBeUndefined();
      expect(deltas.saturation).toBeUndefined();
      expect(deltas.vibrance).toBeUndefined();
      
      expect(areAllDeltasBelowEpsilon(deltas)).toBe(true);
    });
    
    it('should format "already matches" message for epsilon deltas', () => {
      const deltas = {}; // All suppressed
      const display = formatDeltasForDisplay(deltas);
      expect(display).toContain('already matches');
    });
  });
  
  describe('Delta to planned calls conversion', () => {
    it('should convert deltas to planned calls', () => {
      const deltas = {
        temp: 20,
        tint: -10,
        ev: 0.5,
        contrast: 15,
        vibrance: 25,
        saturation: 10,
        aspect: '16:9' as const,
      };
      
      const calls = deltasToPlannedCalls(deltas);
      
      expect(calls).toHaveLength(6);
      
      // Check white balance call
      const wbCall = calls.find(c => c.fn === 'set_white_balance_temp_tint');
      expect(wbCall).toBeDefined();
      expect('args' in wbCall!).toBe(true);
      if ('args' in wbCall!) {
        expect(wbCall.args).toEqual({ temp: 20, tint: -10 });
      }
      
      // Check exposure call
      const evCall = calls.find(c => c.fn === 'set_exposure');
      expect(evCall).toBeDefined();
      expect('args' in evCall!).toBe(true);
      if ('args' in evCall!) {
        expect(evCall.args).toEqual({ ev: 0.5 });
      }
      
      // Check contrast call
      const contrastCall = calls.find(c => c.fn === 'set_contrast');
      expect(contrastCall).toBeDefined();
      expect('args' in contrastCall!).toBe(true);
      if ('args' in contrastCall!) {
        expect(contrastCall.args).toEqual({ amt: 15 });
      }
      
      // Check crop call
      const cropCall = calls.find(c => c.fn === 'set_crop');
      expect(cropCall).toBeDefined();
      expect('args' in cropCall!).toBe(true);
      if ('args' in cropCall!) {
        expect(cropCall.args).toEqual({ aspect: '16:9' });
      }
    });
    
    it('should combine temp and tint into single white balance call', () => {
      const deltas = {
        temp: 30,
        tint: 0,
      };
      
      const calls = deltasToPlannedCalls(deltas);
      
      expect(calls).toHaveLength(1);
      expect(calls[0].fn).toBe('set_white_balance_temp_tint');
      expect('args' in calls[0]).toBe(true);
      if ('args' in calls[0]) {
        expect(calls[0].args).toEqual({ temp: 30, tint: 0 });
      }
    });
  });
  
  describe('Display formatting', () => {
    it('should format deltas for user display', () => {
      const deltas = {
        temp: -20,
        tint: 5,
        ev: -0.3,
        contrast: 25,
        vibrance: 30,
        aspect: '1:1' as const,
      };
      
      const display = formatDeltasForDisplay(deltas);
      
      expect(display).toContain('WB Temp: -20.0');
      expect(display).toContain('WB Tint: +5.0');
      expect(display).toContain('Exposure: -0.30 EV');
      expect(display).toContain('Contrast: +25.0');
      expect(display).toContain('Vibrance: +30.0');
      expect(display).toContain('Crop: 1:1');
    });
  });
});