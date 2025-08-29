import sharp from 'sharp';
import { EditStack } from './editStack.js';
import { applyColorOperations } from './imageProcessing.js';

export interface HistogramData {
  hist: {
    luma: number[];  // 64 buckets
    r: number[];     // 64 buckets
    g: number[];     // 64 buckets
    b: number[];     // 64 buckets
    clip: {
      lowPct: number;   // Percentage of pixels at 0
      highPct: number;  // Percentage of pixels at 255
    };
  };
}

// Compute histogram from image with edit stack applied
export async function computeHistogram(
  imagePath: string,
  editStack: EditStack,
  bins: number = 64
): Promise<HistogramData> {
  // Load image and get metadata
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  
  // Downscale for performance if image is large
  let pipeline = sharp(imagePath);
  const maxDimension = 1024;
  
  if (width > maxDimension || height > maxDimension) {
    if (width > height) {
      pipeline = pipeline.resize({ width: maxDimension });
    } else {
      pipeline = pipeline.resize({ height: maxDimension });
    }
  }
  
  // Apply color operations from edit stack (before geometry)
  const colorOps = editStack.ops.filter(op => 
    op.op === 'white_balance' || 
    op.op === 'exposure' || 
    op.op === 'contrast' ||
    op.op === 'saturation' ||
    op.op === 'vibrance'
  );
  
  if (colorOps.length > 0) {
    pipeline = await applyColorOperations(pipeline, colorOps as any, metadata);
  }
  
  // Get raw buffer after color operations
  const { data: buffer, info } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const channels = info.channels;
  const pixelCount = buffer.length / channels;
  
  // Initialize histogram arrays
  const histLuma = new Array(bins).fill(0);
  const histR = new Array(bins).fill(0);
  const histG = new Array(bins).fill(0);
  const histB = new Array(bins).fill(0);
  
  // Count clipped pixels
  let lowClipped = 0;
  let highClipped = 0;
  
  // Process each pixel
  for (let i = 0; i < buffer.length; i += channels) {
    const r = buffer[i];
    const g = buffer[i + 1];
    const b = buffer[i + 2];
    
    // Calculate luma (Y) using standard coefficients
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    
    // Calculate bin indices (0-255 mapped to 0-63)
    const lumaBin = Math.min(bins - 1, Math.floor(luma * bins / 256));
    const rBin = Math.min(bins - 1, Math.floor(r * bins / 256));
    const gBin = Math.min(bins - 1, Math.floor(g * bins / 256));
    const bBin = Math.min(bins - 1, Math.floor(b * bins / 256));
    
    // Increment histogram bins
    histLuma[lumaBin]++;
    histR[rBin]++;
    histG[gBin]++;
    histB[bBin]++;
    
    // Check for clipping
    if (r === 0 || g === 0 || b === 0) {
      lowClipped++;
    }
    if (r === 255 || g === 255 || b === 255) {
      highClipped++;
    }
  }
  
  // Normalize histograms to percentages (0-100)
  const normalize = (hist: number[]) => {
    const max = Math.max(...hist);
    return hist.map(val => max > 0 ? Math.round((val / max) * 100) : 0);
  };
  
  // Calculate clipping percentages
  const lowPct = Math.round((lowClipped / pixelCount) * 1000) / 10; // Round to 1 decimal
  const highPct = Math.round((highClipped / pixelCount) * 1000) / 10;
  
  return {
    hist: {
      luma: normalize(histLuma),
      r: normalize(histR),
      g: normalize(histG),
      b: normalize(histB),
      clip: {
        lowPct,
        highPct
      }
    }
  };
}

// Generate ASCII sparkline from histogram data
export function generateSparkline(data: number[], width: number = 64): string {
  // Sparkline characters from lowest to highest
  const sparkChars = ' ▁▂▃▄▅▆▇█';
  
  // Normalize data to 0-8 range
  const max = Math.max(...data);
  const normalized = data.map(val => {
    if (max === 0) return 0;
    return Math.min(8, Math.floor((val / max) * 9));
  });
  
  // Generate sparkline
  return normalized.map(val => sparkChars[val]).join('');
}

// Format histogram data as ASCII display
export function formatHistogramDisplay(histData: HistogramData): string {
  const lines: string[] = [];
  
  // Add channel histograms
  lines.push('Histogram:');
  lines.push(`  Luma: ${generateSparkline(histData.hist.luma)}`);
  lines.push(`  Red:  ${generateSparkline(histData.hist.r)}`);
  lines.push(`  Green:${generateSparkline(histData.hist.g)}`);
  lines.push(`  Blue: ${generateSparkline(histData.hist.b)}`);
  
  // Add clipping info
  lines.push(`  Clipping: Low ${histData.hist.clip.lowPct}%, High ${histData.hist.clip.highPct}%`);
  
  return lines.join('\n');
}