import { describe, it, expect, beforeEach } from 'vitest';
import { EditStackManager } from '../src/editStack';

describe('EditStackManager', () => {
  let manager: EditStackManager;
  const testUri = 'file:///test/image.jpg';

  beforeEach(() => {
    manager = new EditStackManager(testUri);
  });

  describe('initialization', () => {
    it('should create empty stack with correct baseUri', () => {
      const stack = manager.getStack();
      expect(stack.version).toBe(1);
      expect(stack.baseUri).toBe(testUri);
      expect(stack.ops).toHaveLength(0);
    });

    it('should report no operations initially', () => {
      expect(manager.hasOperations()).toBe(false);
      expect(manager.getStackLength()).toBe(0);
      expect(manager.getLastOpSummary()).toBe('No operations');
    });
  });

  describe('crop operations', () => {
    it('should add crop with rect', () => {
      manager.addCrop({
        rectNorm: [0.1, 0.2, 0.5, 0.6]
      });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      expect(stack.ops[0].op).toBe('crop');
      const cropOp = stack.ops[0] as any;
      expect(cropOp.rectNorm).toEqual([0.1, 0.2, 0.5, 0.6]);
      expect(stack.ops[0].id).toMatch(/^op_\d+$/);
    });

    it('should clamp rect coordinates to valid range', () => {
      manager.addCrop({
        rectNorm: [-0.1, 1.5, 2.0, 0.5]
      });

      const stack = manager.getStack();
      const cropOp = stack.ops[0] as any;
      const rect = cropOp.rectNorm!;
      expect(rect[0]).toBeGreaterThanOrEqual(0);
      expect(rect[1]).toBeLessThanOrEqual(1);
      expect(rect[2]).toBeGreaterThan(0);
      expect(rect[3]).toBeGreaterThan(0);
    });

    it('should add crop with angle', () => {
      manager.addCrop({
        angleDeg: 45.5
      });

      const stack = manager.getStack();
      const cropOp = stack.ops[0] as any;
      expect(cropOp.angleDeg).toBe(45.5);
    });

    it('should normalize angle to [-180, 180]', () => {
      manager.addCrop({
        angleDeg: 270
      });

      const stack = manager.getStack();
      const cropOp = stack.ops[0] as any;
      expect(cropOp.angleDeg).toBe(-90);
    });

    it('should add crop with aspect', () => {
      manager.addCrop({
        aspect: '16:9'
      });

      const stack = manager.getStack();
      const cropOp = stack.ops[0] as any;
      expect(cropOp.aspect).toBe('16:9');
    });

    it('should amend last crop by default', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      manager.addCrop({ angleDeg: 15 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      const cropOp = stack.ops[0] as any;
      expect(cropOp.angleDeg).toBe(15);
      expect(cropOp.rectNorm).toBeUndefined();
    });

    it('should append new crop with forceNew flag', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      manager.addCrop({ angleDeg: 15, forceNew: true });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(2);
      const cropOp1 = stack.ops[0] as any;
      const cropOp2 = stack.ops[1] as any;
      expect(cropOp1.rectNorm).toEqual([0.1, 0.1, 0.8, 0.8]);
      expect(cropOp2.angleDeg).toBe(15);
    });
  });

  describe('aspect ratio calculations', () => {
    it('should parse aspect ratio strings', () => {
      expect(manager.parseAspect('1:1')).toBe(1);
      expect(manager.parseAspect('16:9')).toBeCloseTo(16/9);
      expect(manager.parseAspect('3:2')).toBe(1.5);
      expect(manager.parseAspect('4.5:3')).toBe(1.5);
    });

    it('should handle aspect keywords', () => {
      expect(manager.parseAspect('square')).toBe(1);
      expect(manager.parseAspect('landscape')).toBe(1.5);
      expect(manager.parseAspect('portrait')).toBeCloseTo(2/3);
      expect(manager.parseAspect('wide')).toBeCloseTo(16/9);
      expect(manager.parseAspect('ultrawide')).toBeCloseTo(21/9);
    });

    it('should return null for invalid aspect', () => {
      expect(manager.parseAspect('invalid')).toBeNull();
      expect(manager.parseAspect('1-1')).toBeNull();
      expect(manager.parseAspect('0:1')).toBeNull();
    });

    it('should compute max inscribed rect for square', () => {
      const rect = manager.computeAspectRect(1920, 1080, '1:1');
      expect(rect).not.toBeNull();
      
      if (rect) {
        const [x, y, w, h] = rect;
        // For a square crop in a 16:9 image, height should be 1 and width should be 9/16
        expect(h).toBe(1);
        expect(w).toBeCloseTo(1080/1920); // 0.5625
        expect(x).toBeCloseTo((1 - w) / 2);
        expect(y).toBe(0);
      }
    });

    it('should compute max inscribed rect for wide aspect', () => {
      const rect = manager.computeAspectRect(1000, 1000, '16:9');
      expect(rect).not.toBeNull();
      
      if (rect) {
        const [x, y, w, h] = rect;
        expect(w).toBe(1);
        expect(h).toBeCloseTo(9/16);
        expect(x).toBe(0);
        expect(y).toBeCloseTo((1 - h) / 2);
      }
    });

    it('should check if rect matches aspect ratio', () => {
      const rect: [number, number, number, number] = [0.25, 0.25, 0.5, 0.5];
      expect(manager.aspectMatchesRect(rect, '1:1')).toBe(true);
      expect(manager.aspectMatchesRect(rect, '16:9')).toBe(false);
    });
  });

  describe('undo/redo operations', () => {
    it('should undo last operation', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      expect(manager.getStackLength()).toBe(1);
      
      const undone = manager.undo();
      expect(undone).toBe(true);
      expect(manager.getStackLength()).toBe(0);
    });

    it('should return false when nothing to undo', () => {
      expect(manager.undo()).toBe(false);
    });

    it('should redo previously undone operation', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      manager.undo();
      
      const redone = manager.redo();
      expect(redone).toBe(true);
      expect(manager.getStackLength()).toBe(1);
    });

    it('should return false when nothing to redo', () => {
      expect(manager.redo()).toBe(false);
    });

    it('should clear redo stack on new operation', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      manager.undo();
      manager.addCrop({ angleDeg: 15 });
      
      expect(manager.redo()).toBe(false);
    });

    it('should handle multiple undo/redo', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8], forceNew: true });
      manager.addCrop({ angleDeg: 15, forceNew: true });
      manager.addCrop({ aspect: '16:9', forceNew: true });
      
      expect(manager.getStackLength()).toBe(3);
      
      manager.undo();
      manager.undo();
      expect(manager.getStackLength()).toBe(1);
      
      manager.redo();
      expect(manager.getStackLength()).toBe(2);
      
      manager.redo();
      expect(manager.getStackLength()).toBe(3);
    });
  });

  describe('reset operation', () => {
    it('should clear all operations', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      manager.addCrop({ angleDeg: 15, forceNew: true });
      
      manager.reset();
      expect(manager.getStackLength()).toBe(0);
      expect(manager.hasOperations()).toBe(false);
    });

    it('should allow undo after reset', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      manager.reset();
      
      const undone = manager.undo();
      expect(undone).toBe(true);
      expect(manager.getStackLength()).toBe(1);
    });
  });

  describe('stack summary and hash', () => {
    it('should generate operation summary', () => {
      manager.addCrop({
        rectNorm: [0.1, 0.2, 0.8, 0.6],
        angleDeg: -1.5,
        aspect: '16:9'
      });
      
      const summary = manager.getLastOpSummary();
      expect(summary).toContain('crop');
      expect(summary).toContain('rect=[0.10,0.20,0.80,0.60]');
      expect(summary).toContain('angle=-1.5°');
      expect(summary).toContain('aspect=16:9');
    });

    it('should compute consistent hash', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      const hash1 = manager.computeHash();
      
      const manager2 = new EditStackManager(testUri);
      manager2.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      const hash2 = manager2.computeHash();
      
      expect(hash1).toBe(hash2);
    });

    it('should compute different hash for different operations', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      const hash1 = manager.computeHash();
      
      manager.addCrop({ angleDeg: 15 });
      const hash2 = manager.computeHash();
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('white balance operations', () => {
    it('should add white balance with gray point', () => {
      manager.addWhiteBalance({
        method: 'gray_point',
        x: 0.5,
        y: 0.3
      });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      expect(stack.ops[0].op).toBe('white_balance');
      const wbOp = stack.ops[0] as any;
      expect(wbOp.method).toBe('gray_point');
      expect(wbOp.x).toBe(0.5);
      expect(wbOp.y).toBe(0.3);
    });

    it('should clamp gray point coordinates', () => {
      manager.addWhiteBalance({
        method: 'gray_point',
        x: 1.5,
        y: -0.2
      });

      const stack = manager.getStack();
      const wbOp = stack.ops[0] as any;
      expect(wbOp.x).toBe(1);
      expect(wbOp.y).toBe(0);
    });

    it('should add white balance with temp/tint', () => {
      manager.addWhiteBalance({
        method: 'temp_tint',
        temp: 20,
        tint: -10
      });

      const stack = manager.getStack();
      const wbOp = stack.ops[0] as any;
      expect(wbOp.method).toBe('temp_tint');
      expect(wbOp.temp).toBe(20);
      expect(wbOp.tint).toBe(-10);
    });

    it('should clamp temp/tint values', () => {
      manager.addWhiteBalance({
        method: 'temp_tint',
        temp: 150,
        tint: -120
      });

      const stack = manager.getStack();
      const wbOp = stack.ops[0] as any;
      expect(wbOp.temp).toBe(100);
      expect(wbOp.tint).toBe(-100);
    });

    it('should amend last white balance by default', () => {
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addWhiteBalance({ method: 'temp_tint', temp: 10 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      const wbOp = stack.ops[0] as any;
      expect(wbOp.method).toBe('temp_tint');
      expect(wbOp.temp).toBe(10);
    });

    it('should append new white balance with forceNew', () => {
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addWhiteBalance({ method: 'temp_tint', temp: 10, forceNew: true });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(2);
    });
  });

  describe('exposure operations', () => {
    it('should add exposure adjustment', () => {
      manager.addExposure({ ev: 1.5 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      expect(stack.ops[0].op).toBe('exposure');
      const expOp = stack.ops[0] as any;
      expect(expOp.ev).toBe(1.5);
    });

    it('should clamp exposure values', () => {
      manager.addExposure({ ev: 5 });

      const stack = manager.getStack();
      const expOp = stack.ops[0] as any;
      expect(expOp.ev).toBe(3);
    });

    it('should clamp negative exposure values', () => {
      manager.addExposure({ ev: -5 });

      const stack = manager.getStack();
      const expOp = stack.ops[0] as any;
      expect(expOp.ev).toBe(-3);
    });

    it('should amend last exposure by default', () => {
      manager.addExposure({ ev: 1 });
      manager.addExposure({ ev: 2 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      const expOp = stack.ops[0] as any;
      expect(expOp.ev).toBe(2);
    });
  });

  describe('contrast operations', () => {
    it('should add contrast adjustment', () => {
      manager.addContrast({ amt: 25 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      expect(stack.ops[0].op).toBe('contrast');
      const conOp = stack.ops[0] as any;
      expect(conOp.amt).toBe(25);
    });

    it('should clamp contrast values', () => {
      manager.addContrast({ amt: 150 });

      const stack = manager.getStack();
      const conOp = stack.ops[0] as any;
      expect(conOp.amt).toBe(100);
    });

    it('should clamp negative contrast values', () => {
      manager.addContrast({ amt: -150 });

      const stack = manager.getStack();
      const conOp = stack.ops[0] as any;
      expect(conOp.amt).toBe(-100);
    });

    it('should amend last contrast by default', () => {
      manager.addContrast({ amt: 10 });
      manager.addContrast({ amt: 20 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      const conOp = stack.ops[0] as any;
      expect(conOp.amt).toBe(20);
    });
  });

  describe('mixed operations and amend-last by kind', () => {
    it('should keep different operation types separate', () => {
      manager.addCrop({ angleDeg: 10 });
      manager.addWhiteBalance({ method: 'temp_tint', temp: 5 });
      manager.addExposure({ ev: 1 });
      manager.addContrast({ amt: 20 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(4);
      expect(stack.ops[0].op).toBe('crop');
      expect(stack.ops[1].op).toBe('white_balance');
      expect(stack.ops[2].op).toBe('exposure');
      expect(stack.ops[3].op).toBe('contrast');
    });

    it('should amend only the last op of the same kind', () => {
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addCrop({ angleDeg: 10 });
      manager.addWhiteBalance({ method: 'temp_tint', temp: 10 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(2);
      expect(stack.ops[0].op).toBe('white_balance');
      expect(stack.ops[1].op).toBe('crop');
      const wbOp = stack.ops[0] as any;
      expect(wbOp.method).toBe('temp_tint');
    });
  });

  describe('stack summary', () => {
    it('should generate correct summary for white balance', () => {
      manager.addWhiteBalance({ method: 'gray_point', x: 0.42, y: 0.37 });
      expect(manager.getStackSummary()).toContain('WB(gray 0.42,0.37)');
    });

    it('should generate correct summary for exposure', () => {
      manager.addExposure({ ev: 0.35 });
      expect(manager.getStackSummary()).toContain('EV +0.35');
    });

    it('should generate correct summary for contrast', () => {
      manager.addContrast({ amt: 12 });
      expect(manager.getStackSummary()).toContain('Contrast +12');
    });

    it('should generate full stack summary', () => {
      manager.addWhiteBalance({ method: 'gray_point', x: 0.42, y: 0.37 });
      manager.addExposure({ ev: 0.35 });
      manager.addContrast({ amt: 12 });
      manager.addCrop({ aspect: '1:1', angleDeg: -1.0 });

      const summary = manager.getStackSummary();
      expect(summary).toContain('WB(gray 0.42,0.37)');
      expect(summary).toContain('EV +0.35');
      expect(summary).toContain('Contrast +12');
      expect(summary).toContain('Crop 1:1');
      expect(summary).toContain('•');
    });
  });

  describe('undo/redo with color operations', () => {
    it('should undo color operations', () => {
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addExposure({ ev: 1 });
      
      expect(manager.getStackLength()).toBe(2);
      
      manager.undo();
      expect(manager.getStackLength()).toBe(1);
      expect(manager.getStack().ops[0].op).toBe('white_balance');
      
      manager.undo();
      expect(manager.getStackLength()).toBe(0);
    });

    it('should redo color operations', () => {
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addExposure({ ev: 1 });
      manager.undo();
      manager.undo();
      
      expect(manager.getStackLength()).toBe(0);
      
      manager.redo();
      expect(manager.getStackLength()).toBe(1);
      expect(manager.getStack().ops[0].op).toBe('white_balance');
      
      manager.redo();
      expect(manager.getStackLength()).toBe(2);
      expect(manager.getStack().ops[1].op).toBe('exposure');
    });
  });
});