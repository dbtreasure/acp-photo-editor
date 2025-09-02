/**
 * Delta Mapper Module for Phase 7e - Reference Look Match
 * 
 * This module computes deterministic deltas between target and reference images
 * based on their statistical properties. All computations are done locally
 * for speed and consistency.
 */

import { PlannedCall } from './planner/types';

// Image statistics structure (matches MCP tool output)
export interface ImageStats {
  w: number;
  h: number;
  mime: string;
  L: {
    p5: number;
    p50: number;
    p95: number;
    mean: number;
    stdev: number;
  };
  AB: {
    a_mean: number;
    b_mean: number;
    chroma_mean: number;
  };
  sat: {
    hsv_mean: number;
    hsv_p95: number;
    colorfulness: number;
  };
  contrast_index: number;
  luma_hist?: number[];
}

// Suggested deltas structure
export interface SuggestedDeltas {
  temp?: number;        // White balance temperature adjustment
  tint?: number;        // White balance tint adjustment
  ev?: number;          // Exposure value adjustment
  contrast?: number;    // Contrast adjustment
  saturation?: number;  // Saturation adjustment
  vibrance?: number;    // Vibrance adjustment
  rotate?: number;      // Rotation angle (if needed)
  aspect?: '1:1' | '3:2' | '4:3' | '16:9';      // Aspect ratio (if different)
}

// Epsilon thresholds for suppressing tiny adjustments
const EPSILON_THRESHOLDS = {
  temp: 5,
  tint: 5,
  ev: 0.1,
  contrast: 5,
  saturation: 5,
  vibrance: 5,
  rotate: 0.5,
};

// Mapping constants (empirically tuned)
const MAPPING_CONSTANTS = {
  temp_k: 2.0,       // Scaling factor for a* channel to temperature
  tint_k: 2.0,       // Scaling factor for b* channel to tint
  ev_per_L: 1 / 12,  // EV change per unit of L* difference
  contrast_k: 2.0,   // Scaling factor for contrast range difference
  vibrance_split: 0.7, // Proportion of color adjustment via vibrance
  saturation_split: 0.3, // Proportion via saturation
};

/**
 * Compute deltas between target and reference images
 * @param targetStats Statistics of the current/target image
 * @param refStats Statistics of the reference image
 * @returns Suggested deltas for matching reference look
 */
export function computeDeltas(targetStats: ImageStats, refStats: ImageStats): SuggestedDeltas {
  const deltas: SuggestedDeltas = {};

  // 1. White Balance (temperature and tint)
  const deltaA = refStats.AB.a_mean - targetStats.AB.a_mean;
  const deltaB = refStats.AB.b_mean - targetStats.AB.b_mean;
  
  // Map LAB deltas to temp/tint adjustments
  const temp = deltaA * MAPPING_CONSTANTS.temp_k;
  const tint = deltaB * MAPPING_CONSTANTS.tint_k;
  
  // Clamp to valid ranges and apply epsilon suppression
  if (Math.abs(temp) >= EPSILON_THRESHOLDS.temp) {
    deltas.temp = Math.max(-100, Math.min(100, temp));
  }
  if (Math.abs(tint) >= EPSILON_THRESHOLDS.tint) {
    deltas.tint = Math.max(-100, Math.min(100, tint));
  }

  // 2. Exposure
  const deltaL = refStats.L.p50 - targetStats.L.p50;
  const ev = deltaL * MAPPING_CONSTANTS.ev_per_L;
  
  if (Math.abs(ev) >= EPSILON_THRESHOLDS.ev) {
    deltas.ev = Math.max(-3, Math.min(3, ev));
  }

  // 3. Contrast
  const targetContrastRange = targetStats.L.p95 - targetStats.L.p5;
  const refContrastRange = refStats.L.p95 - refStats.L.p5;
  const deltaContrast = (refContrastRange - targetContrastRange) * MAPPING_CONSTANTS.contrast_k;
  
  if (Math.abs(deltaContrast) >= EPSILON_THRESHOLDS.contrast) {
    deltas.contrast = Math.max(-100, Math.min(100, deltaContrast));
  }

  // 4. Saturation/Vibrance
  const deltaColorfulness = refStats.sat.colorfulness - targetStats.sat.colorfulness;
  
  // Split between vibrance and saturation (70/30 to protect skin tones)
  const vibranceAdjust = deltaColorfulness * MAPPING_CONSTANTS.vibrance_split;
  const saturationAdjust = deltaColorfulness * MAPPING_CONSTANTS.saturation_split;
  
  if (Math.abs(vibranceAdjust) >= EPSILON_THRESHOLDS.vibrance) {
    deltas.vibrance = Math.max(-100, Math.min(100, vibranceAdjust));
  }
  if (Math.abs(saturationAdjust) >= EPSILON_THRESHOLDS.saturation) {
    deltas.saturation = Math.max(-100, Math.min(100, saturationAdjust));
  }

  // 5. Aspect ratio (optional, no rectNorm)
  const targetAspect = targetStats.w / targetStats.h;
  const refAspect = refStats.w / refStats.h;
  
  // Check for common aspect ratios and assign if significantly different
  if (Math.abs(targetAspect - refAspect) >= 0.1) {
    if (Math.abs(refAspect - 1) < 0.05) {
      deltas.aspect = '1:1'; // Square
    } else if (Math.abs(refAspect - 16/9) < 0.05) {
      deltas.aspect = '16:9';
    } else if (Math.abs(refAspect - 3/2) < 0.05) {
      deltas.aspect = '3:2';
    } else if (Math.abs(refAspect - 4/3) < 0.05) {
      deltas.aspect = '4:3';
    }
  }

  return deltas;
}

/**
 * Check if all deltas are below epsilon thresholds
 * @param deltas Computed deltas
 * @returns true if all deltas are negligible
 */
export function areAllDeltasBelowEpsilon(deltas: SuggestedDeltas): boolean {
  const checks = [
    !deltas.temp || Math.abs(deltas.temp) < EPSILON_THRESHOLDS.temp,
    !deltas.tint || Math.abs(deltas.tint) < EPSILON_THRESHOLDS.tint,
    !deltas.ev || Math.abs(deltas.ev) < EPSILON_THRESHOLDS.ev,
    !deltas.contrast || Math.abs(deltas.contrast) < EPSILON_THRESHOLDS.contrast,
    !deltas.saturation || Math.abs(deltas.saturation) < EPSILON_THRESHOLDS.saturation,
    !deltas.vibrance || Math.abs(deltas.vibrance) < EPSILON_THRESHOLDS.vibrance,
    !deltas.rotate || Math.abs(deltas.rotate) < EPSILON_THRESHOLDS.rotate,
  ];
  
  return checks.every(check => check);
}

/**
 * Convert suggested deltas to planned calls for the planner
 * This provides hints to the planner about what operations to perform
 * @param deltas Suggested deltas
 * @returns Array of planned calls representing the deltas
 */
export function deltasToPlannedCalls(deltas: SuggestedDeltas): PlannedCall[] {
  const calls: PlannedCall[] = [];

  // White balance (combined if both temp and tint present)
  if (deltas.temp !== undefined || deltas.tint !== undefined) {
    calls.push({
      fn: 'set_white_balance_temp_tint',
      args: {
        temp: deltas.temp || 0,
        tint: deltas.tint || 0,
      },
    });
  }

  // Exposure
  if (deltas.ev !== undefined) {
    calls.push({
      fn: 'set_exposure',
      args: { ev: deltas.ev },
    });
  }

  // Contrast
  if (deltas.contrast !== undefined) {
    calls.push({
      fn: 'set_contrast',
      args: { amt: deltas.contrast },
    });
  }

  // Saturation
  if (deltas.saturation !== undefined) {
    calls.push({
      fn: 'set_saturation',
      args: { amt: deltas.saturation },
    });
  }

  // Vibrance
  if (deltas.vibrance !== undefined) {
    calls.push({
      fn: 'set_vibrance',
      args: { amt: deltas.vibrance },
    });
  }

  // Rotation
  if (deltas.rotate !== undefined) {
    calls.push({
      fn: 'set_rotate',
      args: { angleDeg: deltas.rotate },
    });
  }

  // Aspect ratio crop
  if (deltas.aspect !== undefined) {
    calls.push({
      fn: 'set_crop',
      args: { aspect: deltas.aspect },
    });
  }

  return calls;
}

/**
 * Format deltas for display to user
 * @param deltas Suggested deltas
 * @returns Human-readable string describing the deltas
 */
export function formatDeltasForDisplay(deltas: SuggestedDeltas): string {
  if (areAllDeltasBelowEpsilon(deltas)) {
    return 'Image already matches reference (all deltas below threshold)';
  }

  const parts: string[] = [];
  
  if (deltas.temp !== undefined) {
    parts.push(`WB Temp: ${deltas.temp > 0 ? '+' : ''}${deltas.temp.toFixed(1)}`);
  }
  if (deltas.tint !== undefined) {
    parts.push(`WB Tint: ${deltas.tint > 0 ? '+' : ''}${deltas.tint.toFixed(1)}`);
  }
  if (deltas.ev !== undefined) {
    parts.push(`Exposure: ${deltas.ev > 0 ? '+' : ''}${deltas.ev.toFixed(2)} EV`);
  }
  if (deltas.contrast !== undefined) {
    parts.push(`Contrast: ${deltas.contrast > 0 ? '+' : ''}${deltas.contrast.toFixed(1)}`);
  }
  if (deltas.saturation !== undefined) {
    parts.push(`Saturation: ${deltas.saturation > 0 ? '+' : ''}${deltas.saturation.toFixed(1)}`);
  }
  if (deltas.vibrance !== undefined) {
    parts.push(`Vibrance: ${deltas.vibrance > 0 ? '+' : ''}${deltas.vibrance.toFixed(1)}`);
  }
  if (deltas.rotate !== undefined) {
    parts.push(`Rotate: ${deltas.rotate > 0 ? '+' : ''}${deltas.rotate.toFixed(1)}°`);
  }
  if (deltas.aspect !== undefined) {
    parts.push(`Crop: ${deltas.aspect}`);
  }

  return `Computed deltas: ${parts.join(', ')}`;
}