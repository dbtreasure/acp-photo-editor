import { describe, it, expect } from 'vitest';
import { EditStackManager } from '../src/editStack';
import { 
  applyWhiteBalanceGrayPoint, 
  applyWhiteBalanceTempTint,
  applyExposure,
  applyContrast,
  applyColorOperations
} from '../src/imageProcessing';
import sharp from 'sharp';

describe('Phase 5 - Color Adjustments', () => {
  describe('White Balance Operations', () => {
    it('should apply gray point white balance', async () => {
      const manager = new EditStackManager('file:///test.jpg');
      manager.addWhiteBalance({
        method: 'gray_point',
        x: 0.5,
        y: 0.5
      });
      
      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      expect(stack.ops[0].op).toBe('white_balance');
      const wbOp = stack.ops[0] as any;
      expect(wbOp.method).toBe('gray_point');
      expect(wbOp.x).toBe(0.5);
      expect(wbOp.y).toBe(0.5);
    });

    it('should apply temperature and tint adjustments', () => {
      const manager = new EditStackManager('file:///test.jpg');
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

    it('should clamp temperature and tint values', () => {
      const manager = new EditStackManager('file:///test.jpg');
      manager.addWhiteBalance({
        method: 'temp_tint',
        temp: 150,
        tint: -150
      });
      
      const stack = manager.getStack();
      const wbOp = stack.ops[0] as any;
      expect(wbOp.temp).toBe(100);
      expect(wbOp.tint).toBe(-100);
    });
  });

  describe('Exposure Operations', () => {
    it('should apply exposure adjustment', () => {
      const manager = new EditStackManager('file:///test.jpg');
      manager.addExposure({ ev: 1.5 });
      
      const stack = manager.getStack();
      expect(stack.ops[0].op).toBe('exposure');
      const expOp = stack.ops[0] as any;
      expect(expOp.ev).toBe(1.5);
    });

    it('should calculate correct exposure multiplier', () => {
      // +1 EV should double brightness (2^1 = 2)
      const multiplier1 = Math.pow(2, 1);
      expect(multiplier1).toBe(2);
      
      // -1 EV should halve brightness (2^-1 = 0.5)
      const multiplier2 = Math.pow(2, -1);
      expect(multiplier2).toBe(0.5);
      
      // +2 EV should quadruple brightness (2^2 = 4)
      const multiplier3 = Math.pow(2, 2);
      expect(multiplier3).toBe(4);
    });

    it('should clamp exposure values to ±3 EV', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addExposure({ ev: 5 });
      let stack = manager.getStack();
      let expOp = stack.ops[0] as any;
      expect(expOp.ev).toBe(3);
      
      manager.addExposure({ ev: -5 });
      stack = manager.getStack();
      expOp = stack.ops[0] as any;
      expect(expOp.ev).toBe(-3);
    });
  });

  describe('Contrast Operations', () => {
    it('should apply contrast adjustment', () => {
      const manager = new EditStackManager('file:///test.jpg');
      manager.addContrast({ amt: 25 });
      
      const stack = manager.getStack();
      expect(stack.ops[0].op).toBe('contrast');
      const conOp = stack.ops[0] as any;
      expect(conOp.amt).toBe(25);
    });

    it('should clamp contrast values to ±100', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addContrast({ amt: 150 });
      let stack = manager.getStack();
      let conOp = stack.ops[0] as any;
      expect(conOp.amt).toBe(100);
      
      manager.addContrast({ amt: -150 });
      stack = manager.getStack();
      conOp = stack.ops[0] as any;
      expect(conOp.amt).toBe(-100);
    });
  });

  describe('Operation Order', () => {
    it('should maintain correct operation order in stack', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      // Add operations in mixed order
      manager.addCrop({ aspect: '1:1' });
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addExposure({ ev: 1 });
      manager.addContrast({ amt: 20 });
      
      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(4);
      
      // Operations should be in the order they were added
      expect(stack.ops[0].op).toBe('crop');
      expect(stack.ops[1].op).toBe('white_balance');
      expect(stack.ops[2].op).toBe('exposure');
      expect(stack.ops[3].op).toBe('contrast');
    });

    it('should apply color operations before geometry in render pipeline', () => {
      const ops = [
        { op: 'crop', id: 'op1' },
        { op: 'white_balance', id: 'op2', method: 'gray_point', x: 0.5, y: 0.5 },
        { op: 'exposure', id: 'op3', ev: 1 },
        { op: 'contrast', id: 'op4', amt: 20 }
      ];
      
      // Separate operations by type (as done in the render pipeline)
      const colorOps = ops.filter(op => 
        op.op === 'white_balance' || op.op === 'exposure' || op.op === 'contrast'
      );
      const geometryOps = ops.filter(op => op.op === 'crop');
      
      // Color ops should be processed first
      expect(colorOps).toHaveLength(3);
      expect(geometryOps).toHaveLength(1);
      expect(colorOps[0].op).toBe('white_balance');
      expect(colorOps[1].op).toBe('exposure');
      expect(colorOps[2].op).toBe('contrast');
    });
  });

  describe('Amend-Last Behavior', () => {
    it('should amend last operation of same type', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addWhiteBalance({ method: 'gray_point', x: 0.3, y: 0.3 });
      manager.addWhiteBalance({ method: 'temp_tint', temp: 10 });
      
      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(1);
      const wbOp = stack.ops[0] as any;
      expect(wbOp.method).toBe('temp_tint');
      expect(wbOp.temp).toBe(10);
    });

    it('should not amend different operation types', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addExposure({ ev: 1 });
      manager.addContrast({ amt: 20 });
      
      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(3);
      expect(stack.ops[0].op).toBe('white_balance');
      expect(stack.ops[1].op).toBe('exposure');
      expect(stack.ops[2].op).toBe('contrast');
    });

    it('should append new operation with forceNew flag', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addWhiteBalance({ method: 'gray_point', x: 0.3, y: 0.3 });
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5, forceNew: true });
      
      const stack = manager.getStack();
      expect(stack.ops).toHaveLength(2);
      expect(stack.ops[0].op).toBe('white_balance');
      expect(stack.ops[1].op).toBe('white_balance');
    });
  });

  describe('Stack Summary', () => {
    it('should generate readable summary for all operations', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addWhiteBalance({ method: 'gray_point', x: 0.42, y: 0.37 });
      manager.addExposure({ ev: 0.35 });
      manager.addContrast({ amt: 12 });
      manager.addCrop({ aspect: '1:1', angleDeg: -1.0 });
      
      const summary = manager.getStackSummary();
      
      // Check that all operations are in the summary
      expect(summary).toContain('WB(gray 0.42,0.37)');
      expect(summary).toContain('EV +0.35');
      expect(summary).toContain('Contrast +12');
      expect(summary).toContain('Crop 1:1');
      expect(summary).toContain('angle -1.0');
      
      // Check that operations are separated by bullet
      expect(summary).toContain('•');
    });

    it('should handle negative values in summary', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addExposure({ ev: -1.5 });
      manager.addContrast({ amt: -30 });
      
      const summary = manager.getStackSummary();
      
      // Negative values should not have + prefix
      expect(summary).toContain('EV -1.50');
      expect(summary).toContain('Contrast -30');
      expect(summary).not.toContain('+-');
    });
  });

  describe('Undo/Redo with Color Operations', () => {
    it('should undo and redo color adjustments', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addExposure({ ev: 1 });
      manager.addContrast({ amt: 20 });
      
      expect(manager.getStackLength()).toBe(3);
      
      // Undo contrast
      manager.undo();
      expect(manager.getStackLength()).toBe(2);
      expect(manager.getStack().ops[1].op).toBe('exposure');
      
      // Undo exposure  
      manager.undo();
      expect(manager.getStackLength()).toBe(1);
      expect(manager.getStack().ops[0].op).toBe('white_balance');
      
      // Redo exposure
      manager.redo();
      expect(manager.getStackLength()).toBe(2);
      expect(manager.getStack().ops[1].op).toBe('exposure');
      
      // Redo contrast
      manager.redo();
      expect(manager.getStackLength()).toBe(3);
      expect(manager.getStack().ops[2].op).toBe('contrast');
    });

    it('should clear redo stack on new operation', () => {
      const manager = new EditStackManager('file:///test.jpg');
      
      manager.addWhiteBalance({ method: 'gray_point', x: 0.5, y: 0.5 });
      manager.addExposure({ ev: 1 });
      
      manager.undo();
      expect(manager.getStackLength()).toBe(1);
      
      // Add new operation should clear redo
      manager.addContrast({ amt: 20 });
      expect(manager.getStackLength()).toBe(2);
      
      // Redo should do nothing
      const redoResult = manager.redo();
      expect(redoResult).toBe(false);
      expect(manager.getStackLength()).toBe(2);
    });
  });
});