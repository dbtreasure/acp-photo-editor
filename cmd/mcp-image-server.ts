#!/usr/bin/env node
// Load environment variables from .env file
try {
  require('dotenv').config();
} catch (e) {
  // dotenv is optional, ignore if not available
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from 'crypto';
import {
  EditStack,
  EditOp,
  CropOp,
  WhiteBalanceOp,
  ExposureOp,
  ContrastOp,
  SaturationOp,
  VibranceOp,
} from '../src/editStack.js';
import { applyColorOperations } from '../src/imageProcessing.js';
import { computeHistogram } from '../src/histogram.js';
import { randomBytes } from 'crypto';
import { rename } from 'fs/promises';

// Use MCP_ROOT from environment for proper session sandboxing
const root = process.env.MCP_ROOT || process.cwd();

const ReadImageMetaArgsSchema = z.object({
  uri: z.url(),
});

const RenderThumbnailArgsSchema = z.object({
  uri: z.url(),
  maxPx: z.number().int().positive().default(1024),
});

const EditOpSchema = z.discriminatedUnion('op', [
  // Crop operation
  z.object({
    id: z.string(),
    op: z.literal('crop'),
    rectNorm: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    angleDeg: z.number().optional(),
    aspect: z.string().optional(),
  }),
  // White balance operation
  z.object({
    id: z.string(),
    op: z.literal('white_balance'),
    method: z.enum(['gray_point', 'temp_tint']),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    temp: z.number().min(-100).max(100).optional(),
    tint: z.number().min(-100).max(100).optional(),
  }),
  // Exposure operation
  z.object({
    id: z.string(),
    op: z.literal('exposure'),
    ev: z.number().min(-3).max(3),
  }),
  // Contrast operation
  z.object({
    id: z.string(),
    op: z.literal('contrast'),
    amt: z.number().min(-100).max(100),
  }),
  // Saturation operation
  z.object({
    id: z.string(),
    op: z.literal('saturation'),
    amt: z.number().min(-100).max(100),
  }),
  // Vibrance operation
  z.object({
    id: z.string(),
    op: z.literal('vibrance'),
    amt: z.number().min(-100).max(100),
  }),
]);

const RenderPreviewArgsSchema = z.object({
  uri: z.url(),
  editStack: z.object({
    version: z.literal(1),
    baseUri: z.string(),
    ops: z.array(EditOpSchema),
  }),
  maxPx: z.number().int().positive().default(1024),
  format: z.enum(['jpeg', 'png']).optional().default('jpeg'),
  quality: z.number().min(1).max(100).optional().default(60),
});

const ComputeAspectRectArgsSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  aspect: z.string(),
});

const CommitVersionArgsSchema = z.object({
  uri: z.url(),
  editStack: z.object({
    version: z.literal(1),
    baseUri: z.string(),
    ops: z.array(EditOpSchema),
  }),
  dstUri: z.url(),
  format: z.enum(['jpeg', 'png']).optional().default('jpeg'),
  quality: z.number().min(1).max(100).optional().default(90),
  chromaSubsampling: z.enum(['4:4:4', '4:2:0']).optional().default('4:2:0'),
  stripExif: z.boolean().optional().default(true),
  colorProfile: z.enum(['srgb', 'displayp3']).optional().default('srgb'),
  overwrite: z.boolean().optional().default(false),
});

const ComputeHistogramArgsSchema = z.object({
  uri: z.url(),
  editStack: z.object({
    version: z.literal(1),
    baseUri: z.string(),
    ops: z.array(EditOpSchema),
  }),
  bins: z.number().int().positive().optional().default(64),
});

const ImageStatsArgsSchema = z.object({
  uri: z.url(),
  maxPx: z.number().int().positive().optional().default(1024),
});

const SUPPORTED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/svg+xml',
  'image/gif',
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Cache for decoded images and rendered previews
const imageCache = new Map<string, Buffer>();
const previewCache = new Map<string, Buffer>();

function getCacheKey(uri: string, stackHash?: string, maxPx?: number): string {
  const parts = [uri];
  if (stackHash) parts.push(stackHash);
  if (maxPx) parts.push(String(maxPx));
  return parts.join('|');
}

function validatePath(filePath: string): void {
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new McpError(ErrorCode.InvalidRequest, `Path outside root directory: ${filePath}`);
  }
}

async function getMimeType(filePath: string): Promise<string> {
  try {
    // Prefer metadata-based detection for safety
    const metadata = await sharp(filePath).metadata();

    // Map sharp format to MIME type
    const formatToMime: Record<string, string> = {
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      heif: 'image/heif',
      heic: 'image/heic',
      tiff: 'image/tiff',
      tif: 'image/tiff',
      svg: 'image/svg+xml',
      gif: 'image/gif',
    };

    if (metadata.format && formatToMime[metadata.format]) {
      return formatToMime[metadata.format];
    }
  } catch (err) {
    // Fall back to extension-based detection if metadata fails
    console.error('Failed to read metadata for MIME type detection:', err);
  }

  // Fallback to extension-based detection
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
  };

  return mimeMap[ext] || 'application/octet-stream';
}

// Helper functions for image statistics

function rgbToLab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  // Normalize RGB to [0, 1]
  r = r / 255;
  g = g / 255;
  b = b / 255;

  // Convert to linear RGB (remove gamma)
  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

  // Convert to XYZ (D65 illuminant)
  let x = r * 0.4124564 + g * 0.3575761 + b * 0.2419026;
  let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

  // Normalize for D65 illuminant
  x = x / 0.95047;
  y = y / 1.00000;
  z = z / 1.08883;

  // Convert to LAB
  const fx = x > 0.008856 ? Math.pow(x, 1/3) : (7.787 * x + 16/116);
  const fy = y > 0.008856 ? Math.pow(y, 1/3) : (7.787 * y + 16/116);
  const fz = z > 0.008856 ? Math.pow(z, 1/3) : (7.787 * z + 16/116);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bStar = 200 * (fy - fz);

  return { L, a, b: bStar };
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r = r / 255;
  g = g / 255;
  b = b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h = h * 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  return { h, s: s * 100, v: v * 100 };
}

function computeLABStats(data: Buffer, width: number, height: number) {
  const labValues: { L: number[]; a: number[]; b: number[] } = {
    L: [],
    a: [],
    b: [],
  };

  // Sample every pixel (or subsample for performance)
  const channels = data.length / (width * height);
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lab = rgbToLab(r, g, b);
    labValues.L.push(lab.L);
    labValues.a.push(lab.a);
    labValues.b.push(lab.b);
  }

  // Sort L values for percentiles
  labValues.L.sort((a, b) => a - b);
  
  // Calculate percentiles
  const p5 = labValues.L[Math.floor(labValues.L.length * 0.05)];
  const p50 = labValues.L[Math.floor(labValues.L.length * 0.50)];
  const p95 = labValues.L[Math.floor(labValues.L.length * 0.95)];

  // Calculate mean and stdev for L
  const lMean = labValues.L.reduce((sum, val) => sum + val, 0) / labValues.L.length;
  const lVariance = labValues.L.reduce((sum, val) => sum + Math.pow(val - lMean, 2), 0) / labValues.L.length;
  const lStdev = Math.sqrt(lVariance);

  // Calculate mean a and b
  const aMean = labValues.a.reduce((sum, val) => sum + val, 0) / labValues.a.length;
  const bMean = labValues.b.reduce((sum, val) => sum + val, 0) / labValues.b.length;
  
  // Calculate mean chroma
  const chromaValues = labValues.a.map((a, idx) => 
    Math.sqrt(a * a + labValues.b[idx] * labValues.b[idx])
  );
  const chromaMean = chromaValues.reduce((sum, val) => sum + val, 0) / chromaValues.length;

  return {
    L: { p5, p50, p95, mean: lMean, stdev: lStdev },
    AB: { a_mean: aMean, b_mean: bMean, chroma_mean: chromaMean },
  };
}

function computeSaturationStats(data: Buffer, width: number, height: number) {
  const hsvSaturations: number[] = [];
  const channels = data.length / (width * height);

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const hsv = rgbToHsv(r, g, b);
    hsvSaturations.push(hsv.s);
  }

  // Sort for percentiles
  hsvSaturations.sort((a, b) => a - b);
  
  const hsvMean = hsvSaturations.reduce((sum, val) => sum + val, 0) / hsvSaturations.length;
  const hsvP95 = hsvSaturations[Math.floor(hsvSaturations.length * 0.95)];

  // Compute colorfulness metric (simplified Hasler & Süsstrunk)
  let rg_sum = 0, yb_sum = 0;
  let rg_sq_sum = 0, yb_sq_sum = 0;
  let pixelCount = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    
    rg_sum += rg;
    yb_sum += yb;
    rg_sq_sum += rg * rg;
    yb_sq_sum += yb * yb;
    pixelCount++;
  }

  const rg_mean = rg_sum / pixelCount;
  const yb_mean = yb_sum / pixelCount;
  const rg_stdev = Math.sqrt(rg_sq_sum / pixelCount - rg_mean * rg_mean);
  const yb_stdev = Math.sqrt(yb_sq_sum / pixelCount - yb_mean * yb_mean);
  
  const colorfulness = Math.sqrt(rg_stdev * rg_stdev + yb_stdev * yb_stdev) + 
                       0.3 * Math.sqrt(rg_mean * rg_mean + yb_mean * yb_mean);

  return {
    hsv_mean: hsvMean,
    hsv_p95: hsvP95,
    colorfulness,
  };
}

function computeLumaHistogram(data: Buffer, width: number, height: number, bins: number): number[] {
  const histogram = new Array(bins).fill(0);
  const channels = data.length / (width * height);
  
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    // Calculate luma (ITU-R BT.709)
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const bin = Math.min(Math.floor(luma * bins / 256), bins - 1);
    histogram[bin]++;
  }
  
  // Normalize histogram
  const total = width * height;
  return histogram.map(count => count / total);
}

const server = new Server(
  {
    name: 'mcp-image-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// Resources handler
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: `file://${root}`,
        name: 'Session Root Images',
        description: 'Access to image files in the session root directory',
        mimeType: 'text/plain',
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (!uri.startsWith('file://')) {
    throw new McpError(ErrorCode.InvalidRequest, 'Only file:// URIs are supported');
  }

  const filePath = fileURLToPath(uri);
  validatePath(filePath);

  const stats = await fs.stat(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    throw new McpError(ErrorCode.InvalidRequest, `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
  }

  const mimeType = await getMimeType(filePath);
  if (!SUPPORTED_MIMES.has(mimeType)) {
    throw new McpError(ErrorCode.InvalidRequest, `Unsupported mime type: ${mimeType}`);
  }

  const contents = await fs.readFile(filePath);

  return {
    contents: [
      {
        uri,
        mimeType,
        blob: contents.toString('base64'),
      },
    ],
  };
});

// Tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'read_image_meta',
        description: 'Read metadata from an image file',
        inputSchema: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'file:// URI to the image',
            },
          },
          required: ['uri'],
        },
      },
      {
        name: 'render_thumbnail',
        description: 'Render a thumbnail of an image',
        inputSchema: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'file:// URI to the image',
            },
            maxPx: {
              type: 'number',
              description: 'Maximum dimension in pixels',
              default: 1024,
            },
          },
          required: ['uri'],
        },
      },
      {
        name: 'render_preview',
        description: 'Render a preview of an image with edit operations applied',
        inputSchema: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'file:// URI to the image',
            },
            editStack: {
              type: 'object',
              description: 'Edit stack with operations to apply',
              properties: {
                version: { type: 'number' },
                baseUri: { type: 'string' },
                ops: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      op: { type: 'string' },
                      rectNorm: {
                        type: 'array',
                        items: { type: 'number' },
                        minItems: 4,
                        maxItems: 4,
                      },
                      angleDeg: { type: 'number' },
                      aspect: { type: 'string' },
                    },
                    required: ['id', 'op'],
                  },
                },
              },
              required: ['version', 'baseUri', 'ops'],
            },
            maxPx: {
              type: 'number',
              description: 'Maximum dimension in pixels for preview',
              default: 1024,
            },
          },
          required: ['uri', 'editStack'],
        },
      },
      {
        name: 'compute_aspect_rect',
        description: 'Compute maximum inscribed rectangle for given aspect ratio',
        inputSchema: {
          type: 'object',
          properties: {
            width: {
              type: 'number',
              description: 'Image width in pixels',
            },
            height: {
              type: 'number',
              description: 'Image height in pixels',
            },
            aspect: {
              type: 'string',
              description: 'Aspect ratio (e.g., "1:1", "16:9", "square")',
            },
          },
          required: ['width', 'height', 'aspect'],
        },
      },
      {
        name: 'commit_version',
        description: 'Render and write edited image to disk at full resolution',
        inputSchema: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'Source file:// URI',
            },
            editStack: {
              type: 'object',
              description: 'Edit stack to apply',
              properties: {
                version: { type: 'number' },
                baseUri: { type: 'string' },
                ops: { type: 'array' },
              },
              required: ['version', 'baseUri', 'ops'],
            },
            dstUri: {
              type: 'string',
              description: 'Destination file:// URI',
            },
            format: {
              type: 'string',
              enum: ['jpeg', 'png'],
              default: 'jpeg',
            },
            quality: {
              type: 'number',
              minimum: 1,
              maximum: 100,
              default: 90,
            },
            chromaSubsampling: {
              type: 'string',
              enum: ['4:4:4', '4:2:0'],
              default: '4:2:0',
            },
            stripExif: {
              type: 'boolean',
              default: true,
            },
            colorProfile: {
              type: 'string',
              enum: ['srgb', 'displayp3'],
              default: 'srgb',
            },
            overwrite: {
              type: 'boolean',
              default: false,
            },
          },
          required: ['uri', 'editStack', 'dstUri'],
        },
      },
      {
        name: 'compute_histogram',
        description: 'Compute histogram and clipping statistics for an image with edit stack applied',
        inputSchema: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'file:// URI to the image',
            },
            editStack: {
              type: 'object',
              description: 'Edit stack to apply before computing histogram',
              properties: {
                version: { type: 'number' },
                baseUri: { type: 'string' },
                ops: { type: 'array' },
              },
              required: ['version', 'baseUri', 'ops'],
            },
            bins: {
              type: 'number',
              description: 'Number of histogram bins',
              default: 64,
            },
          },
          required: ['uri', 'editStack'],
        },
      },
      {
        name: 'image_stats',
        description: 'Compute comprehensive image statistics for reference matching',
        inputSchema: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'file:// URI to the image',
            },
            maxPx: {
              type: 'number',
              description: 'Maximum dimension for downscaling before analysis',
              default: 1024,
            },
          },
          required: ['uri'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'read_image_meta') {
    const { uri } = ReadImageMetaArgsSchema.parse(args);

    if (!uri.startsWith('file://')) {
      throw new McpError(ErrorCode.InvalidRequest, 'Only file:// URIs are supported');
    }

    const filePath = fileURLToPath(uri);
    validatePath(filePath);

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new McpError(ErrorCode.InvalidRequest, `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    const mimeType = await getMimeType(filePath);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new McpError(ErrorCode.InvalidRequest, `Unsupported mime type: ${mimeType}`);
    }

    try {
      const metadata = await sharp(filePath).metadata();

      const hasExif = !!metadata.exif;
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

      // Return human-readable metadata
      const metaText = `${path.basename(filePath)} ${width}×${height}, ${sizeMB}MB, ${mimeType}${hasExif ? ' +EXIF' : ''}`;

      return {
        content: [
          {
            type: 'text',
            text: metaText,
          },
        ],
      };
    } catch (error: any) {
      // Re-throw as McpError for consistent error handling
      throw new McpError(ErrorCode.InternalError, `Failed to read image metadata: ${error.message}`);
    }
  }

  if (name === 'render_thumbnail') {
    const { uri, maxPx } = RenderThumbnailArgsSchema.parse(args);

    if (!uri.startsWith('file://')) {
      throw new McpError(ErrorCode.InvalidRequest, 'Only file:// URIs are supported');
    }

    const filePath = fileURLToPath(uri);
    validatePath(filePath);

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new McpError(ErrorCode.InvalidRequest, `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    const mimeType = await getMimeType(filePath);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new McpError(ErrorCode.InvalidRequest, `Unsupported mime type: ${mimeType}`);
    }

    try {
      // Render thumbnail with sharp (auto-orient for EXIF)
      const thumbnail = await sharp(filePath)
        .rotate() // Auto-rotate based on EXIF orientation
        .resize(maxPx, maxPx, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png() // Always output as PNG for consistency
        .toBuffer();

      // Return structured image content directly
      return {
        content: [
          {
            type: 'image',
            data: thumbnail.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      };
    } catch (error: any) {
      // Re-throw as McpError for consistent error handling
      throw new McpError(ErrorCode.InternalError, `Failed to render thumbnail: ${error.message}`);
    }
  }

  if (name === 'render_preview') {
    const { uri, editStack, maxPx, format, quality } = RenderPreviewArgsSchema.parse(args);

    if (!uri.startsWith('file://')) {
      throw new McpError(ErrorCode.InvalidRequest, 'Only file:// URIs are supported');
    }

    const filePath = fileURLToPath(uri);
    validatePath(filePath);

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new McpError(ErrorCode.InvalidRequest, `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    const mimeType = await getMimeType(filePath);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new McpError(ErrorCode.InvalidRequest, `Unsupported mime type: ${mimeType}`);
    }

    // Compute cache key from stack
    const stackHash = crypto.createHash('sha256').update(JSON.stringify(editStack.ops)).digest('hex').substring(0, 16);

    const cacheKey = getCacheKey(uri, stackHash, maxPx);

    // Check cache
    if (previewCache.has(cacheKey)) {
      const cached = previewCache.get(cacheKey)!;
      return {
        content: [
          {
            type: 'image',
            data: cached.toString('base64'),
            mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
          },
        ],
      };
    }

    try {
      // Start with auto-orient to handle EXIF rotation
      let pipeline = sharp(filePath).rotate(); // Auto-rotate based on EXIF
      const metadata = await sharp(filePath).metadata(); // Get original dimensions
      const originalWidth = metadata.width || 1;
      const originalHeight = metadata.height || 1;

      // Separate operations by type (color before geometry as per PRD)
      const colorOps: Array<WhiteBalanceOp | ExposureOp | ContrastOp | SaturationOp | VibranceOp> = [];
      const geometryOps: CropOp[] = [];

      for (const op of editStack.ops) {
        if (
          op.op === 'white_balance' ||
          op.op === 'exposure' ||
          op.op === 'contrast' ||
          op.op === 'saturation' ||
          op.op === 'vibrance'
        ) {
          colorOps.push(op as WhiteBalanceOp | ExposureOp | ContrastOp | SaturationOp | VibranceOp);
        } else if (op.op === 'crop') {
          geometryOps.push(op as CropOp);
        }
      }

      // Apply color operations first (white balance → exposure → contrast)
      if (colorOps.length > 0) {
        pipeline = await applyColorOperations(pipeline, colorOps, metadata);
      }

      // Then apply geometry operations (crop, rotate)
      for (const op of geometryOps) {
        // Apply crop first if rect is specified
        if (op.rectNorm) {
          const [x, y, w, h] = op.rectNorm;

          // Convert normalized coordinates to pixels
          const cropX = Math.round(x * originalWidth);
          const cropY = Math.round(y * originalHeight);
          const cropWidth = Math.round(w * originalWidth);
          const cropHeight = Math.round(h * originalHeight);

          // Validate and clamp crop region
          const safeX = Math.max(0, Math.min(originalWidth - 1, cropX));
          const safeY = Math.max(0, Math.min(originalHeight - 1, cropY));
          const safeWidth = Math.max(1, Math.min(originalWidth - safeX, cropWidth));
          const safeHeight = Math.max(1, Math.min(originalHeight - safeY, cropHeight));

          pipeline = pipeline.extract({
            left: safeX,
            top: safeY,
            width: safeWidth,
            height: safeHeight,
          });
        }

        // Apply rotation after crop if specified
        if (op.angleDeg !== undefined && op.angleDeg !== 0) {
          pipeline = pipeline.rotate(op.angleDeg, {
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          });
        }
      }

      // Resize to preview size
      let previewPipeline = pipeline.resize(maxPx, maxPx, {
        fit: 'inside',
        withoutEnlargement: true,
      });

      // Apply format and quality settings
      let preview: Buffer;
      let mimeType: string;
      if (format === 'jpeg') {
        preview = await previewPipeline.jpeg({ quality }).toBuffer();
        mimeType = 'image/jpeg';
      } else {
        preview = await previewPipeline.png().toBuffer();
        mimeType = 'image/png';
      }

      // Cache the result
      previewCache.set(cacheKey, preview);

      // Clear old cache entries if too many
      if (previewCache.size > 20) {
        const firstKey = previewCache.keys().next().value;
        if (firstKey) {
          previewCache.delete(firstKey);
        }
      }

      return {
        content: [
          {
            type: 'image',
            data: preview.toString('base64'),
            mimeType,
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to render preview: ${error.message}`);
    }
  }

  if (name === 'compute_aspect_rect') {
    const { width, height, aspect } = ComputeAspectRectArgsSchema.parse(args);

    // Parse aspect ratio
    const keywords: Record<string, string> = {
      square: '1:1',
      landscape: '3:2',
      portrait: '2:3',
      wide: '16:9',
      ultrawide: '21:9',
    };

    const normalized = keywords[aspect.toLowerCase()] || aspect;
    const match = normalized.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);

    if (!match) {
      throw new McpError(ErrorCode.InvalidRequest, `Invalid aspect ratio: ${aspect}`);
    }

    const targetW = parseFloat(match[1]);
    const targetH = parseFloat(match[2]);
    const targetRatio = targetW / targetH;
    const imageRatio = width / height;

    let rectW: number, rectH: number;
    if (targetRatio > imageRatio) {
      // Target is wider - fit to width
      rectW = 1;
      rectH = imageRatio / targetRatio;
    } else {
      // Target is taller - fit to height
      rectH = 1;
      rectW = targetRatio / imageRatio;
    }

    // Center the rectangle
    const rectX = (1 - rectW) / 2;
    const rectY = (1 - rectH) / 2;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            rectNorm: [
              Number(rectX.toFixed(4)),
              Number(rectY.toFixed(4)),
              Number(rectW.toFixed(4)),
              Number(rectH.toFixed(4)),
            ],
            aspect: normalized,
          }),
        },
      ],
    };
  }

  if (name === 'commit_version') {
    const { uri, editStack, dstUri, format, quality, chromaSubsampling, stripExif, colorProfile, overwrite } =
      CommitVersionArgsSchema.parse(args);

    const startTime = Date.now();

    // Validate source URI
    if (!uri.startsWith('file://')) {
      throw new McpError(ErrorCode.InvalidRequest, 'Only file:// URIs are supported for source');
    }

    // Validate destination URI
    if (!dstUri.startsWith('file://')) {
      throw new McpError(ErrorCode.InvalidRequest, 'Only file:// URIs are supported for destination');
    }

    const srcPath = fileURLToPath(uri);
    const dstPath = fileURLToPath(dstUri);

    // Validate paths are within MCP_ROOT
    validatePath(srcPath);
    validatePath(dstPath);

    // Warn on extension/format mismatch
    const ext = path.extname(dstPath).toLowerCase();
    if ((format === 'jpeg' && ext !== '.jpg' && ext !== '.jpeg') || (format === 'png' && ext !== '.png')) {
      console.error(
        `Warning: format '${format}' does not match extension '${ext}' in ${path.basename(dstPath)}; proceeding anyway.`
      );
    }

    // Check source file
    const srcStats = await fs.stat(srcPath);
    if (srcStats.size > MAX_FILE_SIZE) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Source file too large: ${srcStats.size} bytes (max ${MAX_FILE_SIZE})`
      );
    }

    // Check if destination exists
    try {
      await fs.stat(dstPath);
      if (!overwrite) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Destination file already exists: ${dstPath}. Use overwrite: true to replace.`
        );
      }
    } catch (e: any) {
      // File doesn't exist, which is fine
      if (e.code !== 'ENOENT') throw e;
    }

    // Ensure destination directory exists
    const dstDir = path.dirname(dstPath);
    await fs.mkdir(dstDir, { recursive: true });

    try {
      // Start with auto-orient to handle EXIF rotation
      let pipeline = sharp(srcPath).rotate(); // Auto-rotate based on EXIF
      const metadata = await sharp(srcPath).metadata(); // Get original dimensions
      const originalWidth = metadata.width || 1;
      const originalHeight = metadata.height || 1;

      // Separate operations by type (color before geometry as per PRD)
      const colorOps: Array<WhiteBalanceOp | ExposureOp | ContrastOp | SaturationOp | VibranceOp> = [];
      const geometryOps: CropOp[] = [];

      for (const op of editStack.ops) {
        if (
          op.op === 'white_balance' ||
          op.op === 'exposure' ||
          op.op === 'contrast' ||
          op.op === 'saturation' ||
          op.op === 'vibrance'
        ) {
          colorOps.push(op as WhiteBalanceOp | ExposureOp | ContrastOp | SaturationOp | VibranceOp);
        } else if (op.op === 'crop') {
          geometryOps.push(op as CropOp);
        }
      }

      // Apply color operations first (white balance → exposure → contrast)
      if (colorOps.length > 0) {
        pipeline = await applyColorOperations(pipeline, colorOps, metadata);
      }

      // Then apply geometry operations (crop, rotate)
      for (const op of geometryOps) {
        // Apply crop first if rect is specified
        if (op.rectNorm) {
          const [x, y, w, h] = op.rectNorm;

          // Convert normalized coordinates to pixels
          const cropX = Math.round(x * originalWidth);
          const cropY = Math.round(y * originalHeight);
          const cropWidth = Math.round(w * originalWidth);
          const cropHeight = Math.round(h * originalHeight);

          // Validate and clamp crop region
          const safeX = Math.max(0, Math.min(originalWidth - 1, cropX));
          const safeY = Math.max(0, Math.min(originalHeight - 1, cropY));
          const safeWidth = Math.max(1, Math.min(originalWidth - safeX, cropWidth));
          const safeHeight = Math.max(1, Math.min(originalHeight - safeY, cropHeight));

          pipeline = pipeline.extract({
            left: safeX,
            top: safeY,
            width: safeWidth,
            height: safeHeight,
          });
        }

        // Apply rotation after crop if specified
        if (op.angleDeg !== undefined && op.angleDeg !== 0) {
          pipeline = pipeline.rotate(op.angleDeg, {
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          });
        }
      }

      // Configure output format
      if (format === 'jpeg') {
        pipeline = pipeline.jpeg({
          quality,
          chromaSubsampling: chromaSubsampling as '4:4:4' | '4:2:0',
          force: true,
        });
      } else if (format === 'png') {
        pipeline = pipeline.png({
          compressionLevel: 9,
          force: true,
        });
      }

      // Remove EXIF if requested
      if (stripExif) {
        pipeline = pipeline.withMetadata({
          orientation: undefined,
          exif: {},
          icc: colorProfile === 'srgb' ? 'sRGB' : undefined,
        });
      } else {
        pipeline = pipeline.withMetadata({
          orientation: 1, // Reset orientation since we've already applied it
          icc: colorProfile === 'srgb' ? 'sRGB' : undefined,
        });
      }

      // Generate temp filename for atomic write
      const tempPath = `${dstPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;

      // Write to temp file
      await pipeline.toFile(tempPath);

      // Get final file stats
      const finalStats = await fs.stat(tempPath);
      const finalMetadata = await sharp(tempPath).metadata();

      // Atomic rename
      await rename(tempPath, dstPath);

      const elapsedMs = Date.now() - startTime;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              dstUri,
              bytes: finalStats.size,
              format,
              width: finalMetadata.width || 0,
              height: finalMetadata.height || 0,
              elapsedMs,
            }),
          },
        ],
      };
    } catch (error: any) {
      // Clean up temp file on error
      const tempPattern = `${dstPath}.tmp.${process.pid}`;
      try {
        const files = await fs.readdir(path.dirname(dstPath));
        for (const file of files) {
          if (file.startsWith(path.basename(tempPattern))) {
            await fs.unlink(path.join(path.dirname(dstPath), file)).catch(() => {});
          }
        }
      } catch {}

      throw new McpError(ErrorCode.InternalError, `Failed to commit version: ${error.message}`);
    }
  }

  if (name === 'compute_histogram') {
    const { uri, editStack, bins } = ComputeHistogramArgsSchema.parse(args);

    if (!uri.startsWith('file://')) {
      throw new McpError(ErrorCode.InvalidRequest, 'Only file:// URIs are supported');
    }

    const filePath = fileURLToPath(uri);
    validatePath(filePath);

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new McpError(ErrorCode.InvalidRequest, `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    const mimeType = await getMimeType(filePath);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new McpError(ErrorCode.InvalidRequest, `Unsupported mime type: ${mimeType}`);
    }

    try {
      // Compute histogram with the edit stack applied
      const histogramData = await computeHistogram(filePath, editStack as EditStack, bins);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(histogramData),
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to compute histogram: ${error.message}`);
    }
  }

  if (name === 'image_stats') {
    const { uri, maxPx } = ImageStatsArgsSchema.parse(args);

    if (!uri.startsWith('file://')) {
      throw new McpError(ErrorCode.InvalidRequest, 'Only file:// URIs are supported');
    }

    const filePath = fileURLToPath(uri);
    validatePath(filePath);

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new McpError(ErrorCode.InvalidRequest, `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    const mimeType = await getMimeType(filePath);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new McpError(ErrorCode.InvalidRequest, `Unsupported mime type: ${mimeType}`);
    }

    try {
      // Load and downscale image
      const pipeline = sharp(filePath)
        .rotate() // Auto-rotate based on EXIF
        .resize(maxPx, maxPx, {
          fit: 'inside',
          withoutEnlargement: true,
        });

      // Get metadata
      const metadata = await pipeline.metadata();
      const originalWidth = metadata.width || 1;
      const originalHeight = metadata.height || 1;

      // Convert to raw RGB for processing
      const { data, info } = await pipeline
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Compute LAB statistics
      const labStats = computeLABStats(data, info.width, info.height);
      
      // Compute saturation statistics
      const satStats = computeSaturationStats(data, info.width, info.height);
      
      // Compute contrast index
      const contrastIndex = labStats.L.p95 - labStats.L.p5;
      
      // Optional: compute luma histogram (32 bins)
      const lumaHist = computeLumaHistogram(data, info.width, info.height, 32);

      const imageStats = {
        w: originalWidth,
        h: originalHeight,
        mime: mimeType,
        L: {
          p5: labStats.L.p5,
          p50: labStats.L.p50,
          p95: labStats.L.p95,
          mean: labStats.L.mean,
          stdev: labStats.L.stdev,
        },
        AB: {
          a_mean: labStats.AB.a_mean,
          b_mean: labStats.AB.b_mean,
          chroma_mean: labStats.AB.chroma_mean,
        },
        sat: {
          hsv_mean: satStats.hsv_mean,
          hsv_p95: satStats.hsv_p95,
          colorfulness: satStats.colorfulness,
        },
        contrast_index: contrastIndex,
        luma_hist: lumaHist,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(imageStats),
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to compute image stats: ${error.message}`);
    }
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with stdio protocol
  console.error('MCP Image Server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
