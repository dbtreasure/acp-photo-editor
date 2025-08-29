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
      expect(stack.ops[0].rectNorm).toEqual([0.1, 0.2, 0.5, 0.6]);
      expect(stack.ops[0].id).toMatch(/^op_\d+$/);
    });

    it('should clamp rect coordinates to valid range', () => {
      manager.addCrop({
        rectNorm: [-0.1, 1.5, 2.0, 0.5]
      });

      const stack = manager.getStack();
      const rect = stack.ops[0].rectNorm!;
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
      expect(stack.ops[0].angleDeg).toBe(45.5);
    });

    it('should normalize angle to [-180, 180]', () => {
      manager.addCrop({
        angleDeg: 270
      });

      const stack = manager.getStack();
      expect(stack.ops[0].angleDeg).toBe(-90);
    });

    it('should add crop with aspect', () => {
      manager.addCrop({
        aspect: '16:9'
      });

      const stack = manager.getStack();
      expect(stack.ops[0].aspect).toBe('16:9');
    });

    it('should amend last crop by default', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      manager.addCrop({ angleDeg: 15 });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      expect(stack.ops[0].angleDeg).toBe(15);
      expect(stack.ops[0].rectNorm).toBeUndefined();
    });

    it('should append new crop with forceNew flag', () => {
      manager.addCrop({ rectNorm: [0.1, 0.1, 0.8, 0.8] });
      manager.addCrop({ angleDeg: 15, forceNew: true });

      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(2);
      expect(stack.ops[0].rectNorm).toEqual([0.1, 0.1, 0.8, 0.8]);
      expect(stack.ops[1].angleDeg).toBe(15);
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
});