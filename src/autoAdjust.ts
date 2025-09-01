import sharp from 'sharp';
import { WhiteBalanceOp, ExposureOp, ContrastOp } from './editStack.js';

// Helper to downsample image for analysis
async function getDownsampledBuffer(
  imagePath: string,
  maxDimension: number = 512
): Promise<{ buffer: Buffer; info: sharp.OutputInfo }> {
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;

  let resizeOptions = {};
  if (width > maxDimension || height > maxDimension) {
    if (width > height) {
      resizeOptions = { width: maxDimension };
    } else {
      resizeOptions = { height: maxDimension };
    }
  }

  const result = await sharp(imagePath).resize(resizeOptions).raw().toBuffer({ resolveWithObject: true });

  return { buffer: result.data, info: result.info };
}

// Auto white balance using gray-world algorithm
export async function autoWhiteBalance(imagePath: string): Promise<WhiteBalanceOp> {
  const { buffer, info } = await getDownsampledBuffer(imagePath, 512);
  const channels = info.channels;
  const pixelCount = buffer.length / channels;

  // Calculate mean values for each channel
  let rSum = 0,
    gSum = 0,
    bSum = 0;

  for (let i = 0; i < buffer.length; i += channels) {
    rSum += buffer[i];
    gSum += buffer[i + 1];
    bSum += buffer[i + 2];
  }

  const rMean = rSum / pixelCount;
  const gMean = gSum / pixelCount;
  const bMean = bSum / pixelCount;

  // Calculate gray value (average of all channels)
  const gray = (rMean + gMean + bMean) / 3;

  // Calculate gains to equalize channels
  const rGain = Math.min(2.0, Math.max(0.5, gray / rMean));
  const gGain = Math.min(2.0, Math.max(0.5, gray / gMean));
  const bGain = Math.min(2.0, Math.max(0.5, gray / bMean));

  // Convert gains to temperature/tint model
  // This is a simplified conversion - temperature affects R/B balance, tint affects G/M balance
  const temp = Math.round((rGain / bGain - 1) * 50); // Simplified mapping to [-100, 100]
  const tint = Math.round((1 - gGain) * 50); // Simplified mapping to [-100, 100]

  return {
    id: 'auto_wb',
    op: 'white_balance',
    method: 'temp_tint',
    temp: Math.max(-100, Math.min(100, temp)),
    tint: Math.max(-100, Math.min(100, tint)),
  };
}

// Auto exposure adjustment targeting mid-tone
export async function autoExposure(imagePath: string, currentWb?: WhiteBalanceOp): Promise<ExposureOp> {
  // Apply white balance if provided before analyzing
  let pipeline = sharp(imagePath);

  if (currentWb) {
    const metadata = await sharp(imagePath).metadata();
    const { applyWhiteBalanceTempTint, applyWhiteBalanceGrayPoint } = await import('./imageProcessing.js');

    if (currentWb.method === 'temp_tint') {
      pipeline = applyWhiteBalanceTempTint(pipeline, currentWb);
    } else if (currentWb.method === 'gray_point') {
      pipeline = await applyWhiteBalanceGrayPoint(pipeline, currentWb, metadata);
    }
  }

  // Get downsampled buffer for analysis
  const resized = await pipeline.resize({ width: 512 }).raw().toBuffer({ resolveWithObject: true });

  const { data: buffer, info } = resized;
  const channels = info.channels;
  const pixelCount = buffer.length / channels;

  // Calculate luma values and build histogram
  const lumaValues: number[] = [];

  for (let i = 0; i < buffer.length; i += channels) {
    const r = buffer[i] / 255;
    const g = buffer[i + 1] / 255;
    const b = buffer[i + 2] / 255;

    // Calculate luma (Y) using standard coefficients
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaValues.push(luma);
  }

  // Sort to find median
  lumaValues.sort((a, b) => a - b);
  const median = lumaValues[Math.floor(lumaValues.length / 2)];

  // Target median around 0.45 in sRGB (approximately 0.18 linear)
  const targetMedian = 0.45;

  // Calculate EV adjustment needed
  // EV = log2(target / current)
  let ev = 0;
  if (median > 0.01) {
    // Avoid division by very small numbers
    ev = Math.log2(targetMedian / median);
  }

  // Clamp to reasonable range
  ev = Math.max(-1.5, Math.min(1.5, ev));

  return {
    id: 'auto_ev',
    op: 'exposure',
    ev: Math.round(ev * 100) / 100, // Round to 2 decimal places
  };
}

// Auto contrast adjustment based on histogram stretching
export async function autoContrast(
  imagePath: string,
  currentWb?: WhiteBalanceOp,
  currentEv?: ExposureOp
): Promise<ContrastOp> {
  // Apply current adjustments before analyzing
  let pipeline = sharp(imagePath);

  if (currentWb) {
    const metadata = await sharp(imagePath).metadata();
    const { applyWhiteBalanceTempTint, applyWhiteBalanceGrayPoint } = await import('./imageProcessing.js');

    if (currentWb.method === 'temp_tint') {
      pipeline = applyWhiteBalanceTempTint(pipeline, currentWb);
    } else if (currentWb.method === 'gray_point') {
      pipeline = await applyWhiteBalanceGrayPoint(pipeline, currentWb, metadata);
    }
  }

  if (currentEv) {
    const { applyExposure } = await import('./imageProcessing.js');
    pipeline = applyExposure(pipeline, currentEv);
  }

  // Get downsampled buffer for analysis
  const resized = await pipeline.resize({ width: 512 }).raw().toBuffer({ resolveWithObject: true });

  const { data: buffer, info } = resized;
  const channels = info.channels;

  // Calculate luma values
  const lumaValues: number[] = [];

  for (let i = 0; i < buffer.length; i += channels) {
    const r = buffer[i] / 255;
    const g = buffer[i + 1] / 255;
    const b = buffer[i + 2] / 255;

    // Calculate luma (Y) using standard coefficients
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaValues.push(luma);
  }

  // Sort to find percentiles
  lumaValues.sort((a, b) => a - b);

  // Find 2% and 98% percentiles
  const lowIndex = Math.floor(lumaValues.length * 0.02);
  const highIndex = Math.floor(lumaValues.length * 0.98);

  const lowPercentile = lumaValues[lowIndex];
  const highPercentile = lumaValues[highIndex];

  // Calculate the stretch factor needed
  const currentRange = highPercentile - lowPercentile;
  const targetRange = 0.96; // Target range from 0.02 to 0.98

  let contrastAmt = 0;
  if (currentRange > 0.01) {
    // Avoid division by very small numbers
    // Convert stretch factor to contrast amount
    const stretchFactor = targetRange / currentRange;

    // Map stretch factor to contrast amount [-100, 100]
    // stretchFactor of 1 = 0 contrast
    // stretchFactor of 2 = 50 contrast (approximate)
    // stretchFactor of 0.5 = -50 contrast (approximate)
    contrastAmt = (stretchFactor - 1) * 50;
  }

  // Clamp to reasonable range
  contrastAmt = Math.max(-40, Math.min(40, contrastAmt));

  return {
    id: 'auto_contrast',
    op: 'contrast',
    amt: Math.round(contrastAmt),
  };
}

// Auto all adjustments (WB → EV → Contrast)
export async function autoAll(imagePath: string): Promise<{
  whiteBalance: WhiteBalanceOp;
  exposure: ExposureOp;
  contrast: ContrastOp;
}> {
  // First, auto white balance
  const whiteBalance = await autoWhiteBalance(imagePath);

  // Then auto exposure with the white balance applied
  const exposure = await autoExposure(imagePath, whiteBalance);

  // Finally auto contrast with both WB and EV applied
  const contrast = await autoContrast(imagePath, whiteBalance, exposure);

  return {
    whiteBalance,
    exposure,
    contrast,
  };
}
