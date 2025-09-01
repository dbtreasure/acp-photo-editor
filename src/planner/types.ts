// Planner interface for Phase 7a-7d
// This contract is stable and will be used by both MockPlanner (7a) and GeminiPlanner (7b-7d)

export type PlannedCall =
  | { fn: 'set_white_balance_temp_tint'; args: { temp: number; tint: number } }
  | { fn: 'set_white_balance_gray'; args: { x: number; y: number } }
  | { fn: 'set_exposure'; args: { ev: number } }
  | { fn: 'set_contrast'; args: { amt: number } }
  | {
      fn: 'set_crop';
      args: {
        aspect?: '1:1' | '3:2' | '4:3' | '16:9';
        rectNorm?: [number, number, number, number];
        angleDeg?: number;
      };
    }
  | { fn: 'undo' }
  | { fn: 'redo' }
  | { fn: 'reset' }
  | {
      fn: 'export_image';
      args?: {
        dst?: string;
        format?: 'jpeg' | 'png';
        quality?: number;
        overwrite?: boolean;
      };
    };

export interface PlannerInput {
  text: string;
  // Phase 7b-7d fields:
  state?: any; // Planner state with image metadata
  // Phase 7c: Vision support
  imageB64?: string; // base64 image for vision (7c)
}

export interface PlannerOutput {
  calls: PlannedCall[];
  notes?: string[]; // Optional notes about processing (e.g., ignored terms, clamped values)
}

export interface Planner {
  plan(input: PlannerInput): PlannerOutput | Promise<PlannerOutput>;
}

// Agent-enforced constraints (applied after planning)
export const PLANNER_CLAMPS = {
  temp: { min: -100, max: 100 },
  tint: { min: -100, max: 100 },
  ev: { min: -3, max: 3 },
  contrast: { min: -100, max: 100 },
  angleDeg: { min: -45, max: 45 },
  quality: { min: 1, max: 100 },
  grayPoint: { min: 0, max: 1 }, // x,y coordinates
} as const;
