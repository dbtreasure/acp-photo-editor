import crypto from 'crypto';

// Edit Stack v1 types matching PRD JSON contract
export interface EditStack {
  version: 1;
  baseUri: string;
  ops: EditOp[];
}

// Base interface for all edit operations
export interface BaseEditOp {
  id: string;
  op: string;
}

// Crop operation
export interface CropOp extends BaseEditOp {
  op: 'crop';
  rectNorm?: [number, number, number, number]; // [x, y, w, h] in [0..1] of original image
  angleDeg?: number; // optional rotation in degrees (applied after crop)
  aspect?: string; // optional aspect ratio hint e.g. "1:1", "3:2", "16:9"
}

// White balance operation
export interface WhiteBalanceOp extends BaseEditOp {
  op: 'white_balance';
  method: 'gray_point' | 'temp_tint';
  // For gray_point method - coordinates normalized to original image
  x?: number;
  y?: number;
  // For temp_tint method - relative units [-100..100]
  temp?: number;
  tint?: number;
}

// Exposure operation
export interface ExposureOp extends BaseEditOp {
  op: 'exposure';
  ev: number; // EV stops [-3..+3]
}

// Contrast operation
export interface ContrastOp extends BaseEditOp {
  op: 'contrast';
  amt: number; // percent [-100..100]
}

// Saturation operation
export interface SaturationOp extends BaseEditOp {
  op: 'saturation';
  amt: number; // percent [-100..100], 0 = no-op
}

// Vibrance operation
export interface VibranceOp extends BaseEditOp {
  op: 'vibrance';
  amt: number; // percent [-100..100], protects already-saturated colors
}

// Union type for all operations
export type EditOp = CropOp | WhiteBalanceOp | ExposureOp | ContrastOp | SaturationOp | VibranceOp;

// Stack manager with undo/redo support
export class EditStackManager {
  private currentStack: EditStack;
  private undoStack: EditStack[] = [];
  private redoStack: EditStack[] = [];
  private opCounter = 0;

  constructor(baseUri: string) {
    this.currentStack = {
      version: 1,
      baseUri,
      ops: []
    };
  }

  // Get current stack
  getStack(): EditStack {
    return JSON.parse(JSON.stringify(this.currentStack));
  }

  // Generate unique op ID
  private generateOpId(): string {
    return `op_${String(++this.opCounter).padStart(2, '0')}`;
  }

  // Validate and clamp rect coordinates
  private validateRect(rect: [number, number, number, number]): [number, number, number, number] {
    const [x, y, w, h] = rect;
    
    // Clamp to [0,1] range
    const clampedX = Math.max(0, Math.min(1, x));
    const clampedY = Math.max(0, Math.min(1, y));
    const clampedW = Math.max(0.001, Math.min(1 - clampedX, w)); // Ensure positive width
    const clampedH = Math.max(0.001, Math.min(1 - clampedY, h)); // Ensure positive height

    return [clampedX, clampedY, clampedW, clampedH];
  }

  // Parse aspect ratio string to numeric ratio
  parseAspect(aspect: string): number | null {
    // Handle common keywords
    const keywords: Record<string, string> = {
      'square': '1:1',
      'landscape': '3:2',
      'portrait': '2:3',
      'wide': '16:9',
      'ultrawide': '21:9'
    };

    const normalized = keywords[aspect.toLowerCase()] || aspect;

    // Parse "w:h" format
    const match = normalized.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (match) {
      const w = parseFloat(match[1]);
      const h = parseFloat(match[2]);
      if (w > 0 && h > 0) {
        return w / h;
      }
    }

    return null;
  }

  // Compute max inscribed rect for aspect ratio
  computeAspectRect(imageWidth: number, imageHeight: number, aspect: string): [number, number, number, number] | null {
    const ratio = this.parseAspect(aspect);
    if (!ratio) return null;

    const imageRatio = imageWidth / imageHeight;

    let w: number, h: number;
    if (ratio > imageRatio) {
      // Target is wider than image - fit to width
      w = 1;
      h = imageRatio / ratio;
    } else {
      // Target is taller than image - fit to height
      h = 1;
      w = ratio / imageRatio;
    }

    // Center the rect
    const x = (1 - w) / 2;
    const y = (1 - h) / 2;

    return [x, y, w, h];
  }

  // Add or amend white balance operation
  addWhiteBalance(options: {
    method: 'gray_point' | 'temp_tint';
    x?: number;
    y?: number;
    temp?: number;
    tint?: number;
    forceNew?: boolean;
  }): void {
    // Save current state for undo
    this.undoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
    this.redoStack = [];

    const newOp: WhiteBalanceOp = {
      id: this.generateOpId(),
      op: 'white_balance',
      method: options.method
    };

    if (options.method === 'gray_point') {
      if (options.x !== undefined && options.y !== undefined) {
        // Clamp coordinates to [0,1]
        newOp.x = Math.max(0, Math.min(1, options.x));
        newOp.y = Math.max(0, Math.min(1, options.y));
      }
    } else if (options.method === 'temp_tint') {
      if (options.temp !== undefined) {
        // Clamp temp to [-100, 100]
        newOp.temp = Math.max(-100, Math.min(100, options.temp));
      }
      if (options.tint !== undefined) {
        // Clamp tint to [-100, 100]
        newOp.tint = Math.max(-100, Math.min(100, options.tint));
      }
    }

    // Amend-last logic: replace most recent white_balance op unless forceNew
    const shouldAmend = !options.forceNew && this.findLastOpByType('white_balance') !== -1;
    
    if (shouldAmend) {
      const idx = this.findLastOpByType('white_balance');
      this.currentStack.ops[idx] = newOp;
    } else {
      this.currentStack.ops.push(newOp);
    }
  }

  // Add or amend exposure operation
  addExposure(options: {
    ev: number;
    forceNew?: boolean;
  }): void {
    // Save current state for undo
    this.undoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
    this.redoStack = [];

    const newOp: ExposureOp = {
      id: this.generateOpId(),
      op: 'exposure',
      ev: Math.max(-3, Math.min(3, options.ev)) // Clamp to [-3, 3]
    };

    // Amend-last logic: replace most recent exposure op unless forceNew
    const shouldAmend = !options.forceNew && this.findLastOpByType('exposure') !== -1;
    
    if (shouldAmend) {
      const idx = this.findLastOpByType('exposure');
      this.currentStack.ops[idx] = newOp;
    } else {
      this.currentStack.ops.push(newOp);
    }
  }

  // Add or amend contrast operation
  addContrast(options: {
    amt: number;
    forceNew?: boolean;
  }): void {
    // Save current state for undo
    this.undoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
    this.redoStack = [];

    const newOp: ContrastOp = {
      id: this.generateOpId(),
      op: 'contrast',
      amt: Math.max(-100, Math.min(100, options.amt)) // Clamp to [-100, 100]
    };

    // Amend-last logic: replace most recent contrast op unless forceNew
    const shouldAmend = !options.forceNew && this.findLastOpByType('contrast') !== -1;
    
    if (shouldAmend) {
      const idx = this.findLastOpByType('contrast');
      this.currentStack.ops[idx] = newOp;
    } else {
      this.currentStack.ops.push(newOp);
    }
  }

  // Add or amend saturation operation
  addSaturation(options: {
    amt: number;
    forceNew?: boolean;
  }): void {
    // Save current state for undo
    this.undoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
    this.redoStack = [];

    const newOp: SaturationOp = {
      id: this.generateOpId(),
      op: 'saturation',
      amt: Math.max(-100, Math.min(100, options.amt)) // Clamp to [-100, 100]
    };

    // Amend-last logic: replace most recent saturation op unless forceNew
    const shouldAmend = !options.forceNew && this.findLastOpByType('saturation') !== -1;
    
    if (shouldAmend) {
      const idx = this.findLastOpByType('saturation');
      this.currentStack.ops[idx] = newOp;
    } else {
      this.currentStack.ops.push(newOp);
    }
  }

  // Add or amend vibrance operation
  addVibrance(options: {
    amt: number;
    forceNew?: boolean;
  }): void {
    // Save current state for undo
    this.undoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
    this.redoStack = [];

    const newOp: VibranceOp = {
      id: this.generateOpId(),
      op: 'vibrance',
      amt: Math.max(-100, Math.min(100, options.amt)) // Clamp to [-100, 100]
    };

    // Amend-last logic: replace most recent vibrance op unless forceNew
    const shouldAmend = !options.forceNew && this.findLastOpByType('vibrance') !== -1;
    
    if (shouldAmend) {
      const idx = this.findLastOpByType('vibrance');
      this.currentStack.ops[idx] = newOp;
    } else {
      this.currentStack.ops.push(newOp);
    }
  }

  // Helper to find last operation by type
  private findLastOpByType(opType: string): number {
    for (let i = this.currentStack.ops.length - 1; i >= 0; i--) {
      if (this.currentStack.ops[i].op === opType) {
        return i;
      }
    }
    return -1;
  }

  // Add or amend crop operation
  addCrop(options: {
    rectNorm?: [number, number, number, number];
    angleDeg?: number;
    aspect?: string;
    forceNew?: boolean; // Force append instead of amend
  }): void {
    // Save current state for undo
    this.undoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
    this.redoStack = []; // Clear redo stack on new operation

    const newOp: CropOp = {
      id: this.generateOpId(),
      op: 'crop'
    };

    if (options.rectNorm) {
      newOp.rectNorm = this.validateRect(options.rectNorm);
    }
    
    if (options.angleDeg !== undefined) {
      // Normalize angle to [-180, 180]
      let angle = options.angleDeg % 360;
      if (angle > 180) angle -= 360;
      if (angle < -180) angle += 360;
      newOp.angleDeg = angle;
    }

    if (options.aspect) {
      newOp.aspect = options.aspect;
    }

    // Check if we should amend the last operation
    const lastOp = this.currentStack.ops[this.currentStack.ops.length - 1];
    const shouldAmend = !options.forceNew && lastOp && lastOp.op === 'crop';

    if (shouldAmend) {
      // Replace the last crop operation
      this.currentStack.ops[this.currentStack.ops.length - 1] = newOp;
    } else {
      // Append new operation
      this.currentStack.ops.push(newOp);
    }
  }

  // Undo last operation
  undo(): boolean {
    if (this.undoStack.length === 0) {
      return false;
    }

    // Save current state to redo stack
    this.redoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
    
    // Restore previous state
    this.currentStack = this.undoStack.pop()!;
    
    return true;
  }

  // Redo previously undone operation
  redo(): boolean {
    if (this.redoStack.length === 0) {
      return false;
    }

    // Save current state to undo stack
    this.undoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
    
    // Restore next state
    this.currentStack = this.redoStack.pop()!;
    
    return true;
  }

  // Reset to original (clear all operations)
  reset(): void {
    // Save current state for undo
    if (this.currentStack.ops.length > 0) {
      this.undoStack.push(JSON.parse(JSON.stringify(this.currentStack)));
      this.redoStack = [];
    }

    this.currentStack.ops = [];
  }

  // Get stack length
  getStackLength(): number {
    return this.currentStack.ops.length;
  }

  // Get summary of full stack
  getStackSummary(): string {
    if (this.currentStack.ops.length === 0) return 'No operations';
    
    const summaries: string[] = [];
    
    for (const op of this.currentStack.ops) {
      let summary = '';
      
      if (op.op === 'crop') {
        const cropOp = op as CropOp;
        summary = 'Crop';
        if (cropOp.aspect) {
          summary += ` ${cropOp.aspect}`;
        }
        if (cropOp.angleDeg !== undefined && cropOp.angleDeg !== 0) {
          summary += ` angle ${cropOp.angleDeg.toFixed(1)}`;
        }
      } else if (op.op === 'white_balance') {
        const wbOp = op as WhiteBalanceOp;
        if (wbOp.method === 'gray_point') {
          summary = `WB(gray ${wbOp.x?.toFixed(2)},${wbOp.y?.toFixed(2)})`;
        } else {
          summary = `WB(temp ${wbOp.temp ?? 0} tint ${wbOp.tint ?? 0})`;
        }
      } else if (op.op === 'exposure') {
        const expOp = op as ExposureOp;
        summary = `EV ${expOp.ev > 0 ? '+' : ''}${expOp.ev.toFixed(2)}`;
      } else if (op.op === 'contrast') {
        const conOp = op as ContrastOp;
        summary = `Contrast ${conOp.amt > 0 ? '+' : ''}${conOp.amt}`;
      } else if (op.op === 'saturation') {
        const satOp = op as SaturationOp;
        summary = `Sat ${satOp.amt > 0 ? '+' : ''}${satOp.amt}`;
      } else if (op.op === 'vibrance') {
        const vibOp = op as VibranceOp;
        summary = `Vib ${vibOp.amt > 0 ? '+' : ''}${vibOp.amt}`;
      }
      
      if (summary) {
        summaries.push(summary);
      }
    }
    
    return summaries.join(' • ');
  }

  // Get summary of last operation
  getLastOpSummary(): string {
    const lastOp = this.currentStack.ops[this.currentStack.ops.length - 1];
    if (!lastOp) return 'No operations';

    const parts: string[] = [lastOp.op];
    
    if (lastOp.op === 'crop') {
      const cropOp = lastOp as CropOp;
      if (cropOp.rectNorm) {
        const [x, y, w, h] = cropOp.rectNorm;
        parts.push(`rect=[${x.toFixed(2)},${y.toFixed(2)},${w.toFixed(2)},${h.toFixed(2)}]`);
      }
      
      if (cropOp.angleDeg !== undefined) {
        parts.push(`angle=${cropOp.angleDeg.toFixed(1)}°`);
      }
      
      if (cropOp.aspect) {
        parts.push(`aspect=${cropOp.aspect}`);
      }
    } else if (lastOp.op === 'white_balance') {
      const wbOp = lastOp as WhiteBalanceOp;
      if (wbOp.method === 'gray_point') {
        parts.push(`gray ${wbOp.x?.toFixed(2)},${wbOp.y?.toFixed(2)}`);
      } else if (wbOp.method === 'temp_tint') {
        parts.push(`temp ${wbOp.temp} tint ${wbOp.tint}`);
      }
    } else if (lastOp.op === 'exposure') {
      const expOp = lastOp as ExposureOp;
      parts.push(`EV ${expOp.ev > 0 ? '+' : ''}${expOp.ev.toFixed(2)}`);
    } else if (lastOp.op === 'contrast') {
      const conOp = lastOp as ContrastOp;
      parts.push(`${conOp.amt > 0 ? '+' : ''}${conOp.amt}`);
    } else if (lastOp.op === 'saturation') {
      const satOp = lastOp as SaturationOp;
      parts.push(`${satOp.amt > 0 ? '+' : ''}${satOp.amt}`);
    } else if (lastOp.op === 'vibrance') {
      const vibOp = lastOp as VibranceOp;
      parts.push(`${vibOp.amt > 0 ? '+' : ''}${vibOp.amt}`);
    }

    return parts.join(' ');
  }

  // Compute hash of current stack for caching
  computeHash(): string {
    const stackStr = JSON.stringify(this.currentStack.ops);
    return crypto.createHash('sha256').update(stackStr).digest('hex').substring(0, 16);
  }

  // Check if stack has any operations
  hasOperations(): boolean {
    return this.currentStack.ops.length > 0;
  }

  // Check if specific aspect ratio matches rect (within 1% tolerance)
  aspectMatchesRect(rect: [number, number, number, number], aspect: string): boolean {
    const ratio = this.parseAspect(aspect);
    if (!ratio) return false;

    const [, , w, h] = rect;
    const rectRatio = w / h;
    const tolerance = 0.01;

    return Math.abs(rectRatio - ratio) / ratio <= tolerance;
  }
}

// Helper to merge partial crop options with defaults
export function mergeCropOptions(
  partial: Partial<CropOp>,
  imageWidth: number,
  imageHeight: number
): CropOp {
  const merged: CropOp = {
    id: partial.id || 'op_temp',
    op: 'crop'
  };

  // If aspect is provided but no rect, compute max inscribed rect
  if (partial.aspect && !partial.rectNorm) {
    const manager = new EditStackManager('');
    const computed = manager.computeAspectRect(imageWidth, imageHeight, partial.aspect);
    if (computed) {
      merged.rectNorm = computed;
      merged.aspect = partial.aspect;
    }
  } else if (partial.rectNorm) {
    merged.rectNorm = partial.rectNorm;
    if (partial.aspect) {
      merged.aspect = partial.aspect;
    }
  }

  if (partial.angleDeg !== undefined) {
    merged.angleDeg = partial.angleDeg;
  }

  return merged;
}

// Types are already exported at the top of the file