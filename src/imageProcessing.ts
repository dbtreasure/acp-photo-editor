import sharp from 'sharp';
import { WhiteBalanceOp, ExposureOp, ContrastOp } from './editStack.js';

// Type definitions for Sharp matrices
type Matrix3x3 = [[number, number, number], [number, number, number], [number, number, number]];

// Apply white balance using gray point method
export async function applyWhiteBalanceGrayPoint(
  pipeline: sharp.Sharp,
  op: WhiteBalanceOp,
  originalMetadata: sharp.Metadata
): Promise<sharp.Sharp> {
  if (op.method !== 'gray_point' || op.x === undefined || op.y === undefined) {
    return pipeline;
  }

  const width = originalMetadata.width || 1;
  const height = originalMetadata.height || 1;
  
  // Get the pixel value at the gray point
  const x = Math.round(op.x * width);
  const y = Math.round(op.y * height);
  
  // Clone the pipeline to sample the pixel
  const sampleBuffer = await pipeline.clone()
    .extract({ left: Math.max(0, x - 2), top: Math.max(0, y - 2), width: 5, height: 5 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const { data, info } = sampleBuffer;
  const channels = info.channels;
  
  // Calculate average of center pixel (or average of the 5x5 region for stability)
  let r = 0, g = 0, b = 0;
  let count = 0;
  
  for (let i = 0; i < data.length; i += channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  
  r /= count;
  g /= count;
  b /= count;
  
  // Calculate the gray value (average of RGB)
  const gray = (r + g + b) / 3;
  
  // Calculate scaling factors for each channel (with limits to prevent extreme corrections)
  const rScale = Math.min(4, Math.max(0.25, gray / r));
  const gScale = Math.min(4, Math.max(0.25, gray / g));
  const bScale = Math.min(4, Math.max(0.25, gray / b));
  
  // Apply the white balance using a color matrix
  // Sharp expects a 3x3 matrix as nested arrays
  const matrix: Matrix3x3 = [
    [rScale, 0, 0],
    [0, gScale, 0],
    [0, 0, bScale]
  ];
  
  return pipeline.recomb(matrix);
}

// Apply white balance using temperature/tint method
export function applyWhiteBalanceTempTint(
  pipeline: sharp.Sharp,
  op: WhiteBalanceOp
): sharp.Sharp {
  if (op.method !== 'temp_tint') {
    return pipeline;
  }

  const temp = op.temp ?? 0; // [-100, 100]
  const tint = op.tint ?? 0; // [-100, 100]
  
  // Convert temp/tint to RGB multipliers
  // Temperature: negative = cooler (more blue), positive = warmer (more red/yellow)
  // Tint: negative = more green, positive = more magenta
  
  // Simple linear model for temperature
  const tempFactor = temp / 100; // [-1, 1]
  const rTemp = 1 + tempFactor * 0.3;  // Red increases with warmth
  const gTemp = 1 + tempFactor * 0.05; // Green slightly affected
  const bTemp = 1 - tempFactor * 0.3;  // Blue decreases with warmth
  
  // Simple linear model for tint
  const tintFactor = tint / 100; // [-1, 1]
  const gTint = 1 - tintFactor * 0.2; // Green decreases with magenta tint
  const rTint = 1 + tintFactor * 0.1; // Slight red adjustment
  const bTint = 1 + tintFactor * 0.1; // Slight blue adjustment
  
  // Combine temperature and tint adjustments
  const rScale = Math.min(2, Math.max(0.5, rTemp * rTint));
  const gScale = Math.min(2, Math.max(0.5, gTemp * gTint));
  const bScale = Math.min(2, Math.max(0.5, bTemp * bTint));
  
  // Apply using color matrix
  // Sharp expects a 3x3 matrix as nested arrays
  const matrix: Matrix3x3 = [
    [rScale, 0, 0],
    [0, gScale, 0],
    [0, 0, bScale]
  ];
  
  return pipeline.recomb(matrix);
}

// Apply exposure adjustment
export function applyExposure(
  pipeline: sharp.Sharp,
  op: ExposureOp
): sharp.Sharp {
  const ev = op.ev; // [-3, 3] stops
  
  // Convert EV to linear multiplier: 2^ev
  const scale = Math.pow(2, ev);
  
  // Apply exposure with a simple tone mapping to prevent clipping
  // Using a basic approach: multiply then apply a gentle shoulder curve
  // Sharp doesn't have direct tone mapping, so we'll use modulate for brightness
  
  // Convert scale to brightness percentage change
  // Sharp's modulate expects a multiplier where 1.0 = no change
  // We'll approximate the exposure change
  const brightness = scale;
  
  // Apply the brightness adjustment
  // Note: Sharp's modulate affects saturation and hue too, so we only adjust brightness
  return pipeline.modulate({
    brightness: brightness,
    saturation: 1.0,  // Keep saturation unchanged
    hue: 0            // Keep hue unchanged
  });
}

// Apply contrast adjustment
export function applyContrast(
  pipeline: sharp.Sharp,
  op: ContrastOp
): sharp.Sharp {
  const amt = op.amt; // [-100, 100] percent
  
  // Sharp doesn't have a direct contrast adjustment,
  // so we'll use linear transformation with a custom formula
  // Contrast around middle gray (0.5 in normalized space)
  
  // Convert percentage to a multiplier
  const contrastFactor = (100 + amt) / 100; // [0, 2]
  
  // Use sharp's linear transformation: output = a * input + b
  // For contrast: output = (input - 0.5) * factor + 0.5
  // Rearranged: output = factor * input + (0.5 * (1 - factor))
  const a = contrastFactor;
  const b = 128 * (1 - contrastFactor); // 128 is middle gray in 8-bit
  
  // Apply the linear transformation
  return pipeline.linear(a, b);
}

// Main function to apply all color operations to a pipeline
export async function applyColorOperations(
  pipeline: sharp.Sharp,
  ops: Array<WhiteBalanceOp | ExposureOp | ContrastOp>,
  originalMetadata: sharp.Metadata
): Promise<sharp.Sharp> {
  let result = pipeline;
  
  // Apply operations in order: white balance → exposure → contrast
  for (const op of ops) {
    if (op.op === 'white_balance') {
      if (op.method === 'gray_point') {
        result = await applyWhiteBalanceGrayPoint(result, op as WhiteBalanceOp, originalMetadata);
      } else if (op.method === 'temp_tint') {
        result = applyWhiteBalanceTempTint(result, op as WhiteBalanceOp);
      }
    } else if (op.op === 'exposure') {
      result = applyExposure(result, op as ExposureOp);
    } else if (op.op === 'contrast') {
      result = applyContrast(result, op as ContrastOp);
    }
  }
  
  return result;
}