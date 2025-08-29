import crypto from 'crypto';

// Edit Stack v1 types matching PRD JSON contract
export interface EditStack {
  version: 1;
  baseUri: string;
  ops: EditOp[];
}

export interface EditOp {
  id: string;
  op: 'crop';
  rectNorm?: [number, number, number, number]; // [x, y, w, h] in [0..1] of original image
  angleDeg?: number; // optional rotation in degrees (applied after crop)
  aspect?: string; // optional aspect ratio hint e.g. "1:1", "3:2", "16:9"
}

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

    const newOp: EditOp = {
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

  // Get summary of last operation
  getLastOpSummary(): string {
    const lastOp = this.currentStack.ops[this.currentStack.ops.length - 1];
    if (!lastOp) return 'No operations';

    const parts: string[] = [lastOp.op];
    
    if (lastOp.rectNorm) {
      const [x, y, w, h] = lastOp.rectNorm;
      parts.push(`rect=[${x.toFixed(2)},${y.toFixed(2)},${w.toFixed(2)},${h.toFixed(2)}]`);
    }
    
    if (lastOp.angleDeg !== undefined) {
      parts.push(`angle=${lastOp.angleDeg.toFixed(1)}°`);
    }
    
    if (lastOp.aspect) {
      parts.push(`aspect=${lastOp.aspect}`);
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
  partial: Partial<EditOp>,
  imageWidth: number,
  imageHeight: number
): EditOp {
  const merged: EditOp = {
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