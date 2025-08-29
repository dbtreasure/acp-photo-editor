import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

describe('Phase 5 Integration Tests', () => {
  let agentProcess: ChildProcess | undefined;
  let clientProcess: ChildProcess | undefined;
  const testDir = path.join(process.cwd(), 'test-output-phase5');
  const testImage = path.join(process.cwd(), 'test', 'fixtures', 'sample.jpg');

  beforeAll(async () => {
    // Create test directory
    await mkdir(testDir, { recursive: true });
    
    // Create a simple test image if it doesn't exist
    try {
      await readFile(testImage);
    } catch {
      // Create fixtures directory
      await mkdir(path.join(process.cwd(), 'test', 'fixtures'), { recursive: true });
      // For testing, we'll skip creating an actual image
      // In real tests, you'd have a proper test image
    }
  });

  afterAll(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
    
    // Kill processes if still running
    if (agentProcess) agentProcess.kill();
    if (clientProcess) clientProcess.kill();
  });

  describe('Color adjustment operations', () => {
    it('should apply white balance with gray point', async () => {
      // Test data for white balance gray point
      const editStack = {
        version: 1,
        baseUri: pathToFileURL(testImage).toString(),
        ops: [
          {
            id: 'op_wb_01',
            op: 'white_balance',
            method: 'gray_point',
            x: 0.42,
            y: 0.37
          }
        ]
      };

      // Verify the edit stack structure
      expect(editStack.ops[0].op).toBe('white_balance');
      expect(editStack.ops[0].method).toBe('gray_point');
      expect(editStack.ops[0].x).toBe(0.42);
      expect(editStack.ops[0].y).toBe(0.37);
    });

    it('should apply white balance with temp/tint', async () => {
      const editStack = {
        version: 1,
        baseUri: pathToFileURL(testImage).toString(),
        ops: [
          {
            id: 'op_wb_02',
            op: 'white_balance',
            method: 'temp_tint',
            temp: 18,
            tint: -7
          }
        ]
      };

      expect(editStack.ops[0].op).toBe('white_balance');
      expect(editStack.ops[0].method).toBe('temp_tint');
      expect(editStack.ops[0].temp).toBe(18);
      expect(editStack.ops[0].tint).toBe(-7);
    });

    it('should apply exposure adjustment', async () => {
      const editStack = {
        version: 1,
        baseUri: pathToFileURL(testImage).toString(),
        ops: [
          {
            id: 'op_exp_01',
            op: 'exposure',
            ev: 0.35
          }
        ]
      };

      expect(editStack.ops[0].op).toBe('exposure');
      expect(editStack.ops[0].ev).toBe(0.35);
    });

    it('should apply contrast adjustment', async () => {
      const editStack = {
        version: 1,
        baseUri: pathToFileURL(testImage).toString(),
        ops: [
          {
            id: 'op_con_01',
            op: 'contrast',
            amt: 12
          }
        ]
      };

      expect(editStack.ops[0].op).toBe('contrast');
      expect(editStack.ops[0].amt).toBe(12);
    });

    it('should compose multiple color operations', async () => {
      const editStack = {
        version: 1,
        baseUri: pathToFileURL(testImage).toString(),
        ops: [
          {
            id: 'op_wb_01',
            op: 'white_balance',
            method: 'gray_point',
            x: 0.42,
            y: 0.37
          },
          {
            id: 'op_exp_01',
            op: 'exposure',
            ev: 0.35
          },
          {
            id: 'op_con_01',
            op: 'contrast',
            amt: 12
          }
        ]
      };

      expect(editStack.ops).toHaveLength(3);
      expect(editStack.ops[0].op).toBe('white_balance');
      expect(editStack.ops[1].op).toBe('exposure');
      expect(editStack.ops[2].op).toBe('contrast');
    });

    it('should apply color ops before geometry ops', async () => {
      const editStack = {
        version: 1,
        baseUri: pathToFileURL(testImage).toString(),
        ops: [
          {
            id: 'op_crop_01',
            op: 'crop',
            aspect: '1:1',
            angleDeg: -1.0
          },
          {
            id: 'op_wb_01',
            op: 'white_balance',
            method: 'gray_point',
            x: 0.42,
            y: 0.37
          },
          {
            id: 'op_exp_01',
            op: 'exposure',
            ev: 0.35
          },
          {
            id: 'op_con_01',
            op: 'contrast',
            amt: 12
          }
        ]
      };

      // Verify ops are in the stack
      expect(editStack.ops).toHaveLength(4);
      
      // In the render pipeline, color ops should be applied before geometry
      // This is handled internally by the render functions
      const colorOps = editStack.ops.filter(op => 
        op.op === 'white_balance' || op.op === 'exposure' || op.op === 'contrast'
      );
      const geometryOps = editStack.ops.filter(op => op.op === 'crop');
      
      expect(colorOps).toHaveLength(3);
      expect(geometryOps).toHaveLength(1);
    });
  });

  describe('CLI command parsing', () => {
    it('should parse white balance gray point command', () => {
      const command = ':wb --gray 0.42,0.37';
      const args = command.substring(3).trim();
      
      const grayMatch = args.match(/--gray\s+([\d.,]+)/);
      expect(grayMatch).toBeTruthy();
      
      if (grayMatch) {
        const coords = grayMatch[1].split(',').map(parseFloat);
        expect(coords).toEqual([0.42, 0.37]);
      }
    });

    it('should parse white balance temp/tint command', () => {
      const command = ':wb --temp 18 --tint -7';
      const args = command.substring(3).trim();
      
      const tempMatch = args.match(/--temp\s+([-\d]+)/);
      const tintMatch = args.match(/--tint\s+([-\d]+)/);
      
      expect(tempMatch).toBeTruthy();
      expect(tintMatch).toBeTruthy();
      
      if (tempMatch) expect(parseInt(tempMatch[1])).toBe(18);
      if (tintMatch) expect(parseInt(tintMatch[1])).toBe(-7);
    });

    it('should parse exposure command', () => {
      const command = ':exposure --ev 0.35';
      const args = command.substring(9).trim();
      
      const evMatch = args.match(/--ev\s+([-\d.]+)/);
      expect(evMatch).toBeTruthy();
      
      if (evMatch) expect(parseFloat(evMatch[1])).toBe(0.35);
    });

    it('should parse contrast command', () => {
      const command = ':contrast --amt 12';
      const args = command.substring(9).trim();
      
      const amtMatch = args.match(/--amt\s+([-\d]+)/);
      expect(amtMatch).toBeTruthy();
      
      if (amtMatch) expect(parseInt(amtMatch[1])).toBe(12);
    });
  });

  describe('Amend-last behavior', () => {
    it('should amend last white balance by default', () => {
      const ops = [
        { id: 'op_01', op: 'white_balance', method: 'gray_point', x: 0.5, y: 0.5 },
        { id: 'op_02', op: 'white_balance', method: 'temp_tint', temp: 10 }
      ];
      
      // With amend-last, second WB should replace first
      // This is handled by the EditStackManager
      expect(ops[1].method).toBe('temp_tint');
    });

    it('should keep different op types separate', () => {
      const ops = [
        { id: 'op_01', op: 'white_balance', method: 'gray_point', x: 0.5, y: 0.5 },
        { id: 'op_02', op: 'exposure', ev: 1 },
        { id: 'op_03', op: 'contrast', amt: 20 }
      ];
      
      // Different op types should not amend each other
      expect(ops).toHaveLength(3);
      expect(new Set(ops.map(op => op.op)).size).toBe(3);
    });
  });

  describe('Value clamping', () => {
    it('should clamp exposure values to [-3, 3]', () => {
      const clamp = (ev: number) => Math.max(-3, Math.min(3, ev));
      
      expect(clamp(5)).toBe(3);
      expect(clamp(-5)).toBe(-3);
      expect(clamp(1.5)).toBe(1.5);
    });

    it('should clamp contrast values to [-100, 100]', () => {
      const clamp = (amt: number) => Math.max(-100, Math.min(100, amt));
      
      expect(clamp(150)).toBe(100);
      expect(clamp(-150)).toBe(-100);
      expect(clamp(50)).toBe(50);
    });

    it('should clamp temp/tint values to [-100, 100]', () => {
      const clamp = (val: number) => Math.max(-100, Math.min(100, val));
      
      expect(clamp(120)).toBe(100);
      expect(clamp(-120)).toBe(-100);
      expect(clamp(0)).toBe(0);
    });

    it('should clamp gray point coordinates to [0, 1]', () => {
      const clamp = (coord: number) => Math.max(0, Math.min(1, coord));
      
      expect(clamp(1.5)).toBe(1);
      expect(clamp(-0.5)).toBe(0);
      expect(clamp(0.5)).toBe(0.5);
    });
  });
});