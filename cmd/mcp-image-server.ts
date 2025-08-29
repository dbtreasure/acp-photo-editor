#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  ListResourcesRequestSchema, 
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from 'crypto';
import { EditStack, EditOp } from '../src/editStack.js';

// Use MCP_ROOT from environment for proper session sandboxing
const root = process.env.MCP_ROOT || process.cwd();

const ReadImageMetaArgsSchema = z.object({
  uri: z.url()
});

const RenderThumbnailArgsSchema = z.object({
  uri: z.url(),
  maxPx: z.number().int().positive().default(1024)
});

const RenderPreviewArgsSchema = z.object({
  uri: z.url(),
  editStack: z.object({
    version: z.literal(1),
    baseUri: z.string(),
    ops: z.array(z.object({
      id: z.string(),
      op: z.literal('crop'),
      rectNorm: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      angleDeg: z.number().optional(),
      aspect: z.string().optional()
    }))
  }),
  maxPx: z.number().int().positive().default(1024)
});

const ComputeAspectRectArgsSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  aspect: z.string()
});

const SUPPORTED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/svg+xml',
  'image/gif'
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
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Path outside root directory: ${filePath}`
    );
  }
}

async function getMimeType(filePath: string): Promise<string> {
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
    '.gif': 'image/gif'
  };
  
  return mimeMap[ext] || 'application/octet-stream';
}

const server = new Server(
  {
    name: 'mcp-image-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
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
        mimeType: 'text/plain'
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  
  if (!uri.startsWith('file://')) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'Only file:// URIs are supported'
    );
  }
  
  const filePath = fileURLToPath(uri);
  validatePath(filePath);
  
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`
    );
  }
  
  const mimeType = await getMimeType(filePath);
  if (!SUPPORTED_MIMES.has(mimeType)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Unsupported mime type: ${mimeType}`
    );
  }
  
  const contents = await fs.readFile(filePath);
  
  return {
    contents: [
      {
        uri,
        mimeType,
        blob: contents.toString('base64')
      }
    ]
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
              description: 'file:// URI to the image'
            }
          },
          required: ['uri']
        }
      },
      {
        name: 'render_thumbnail',
        description: 'Render a thumbnail of an image',
        inputSchema: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'file:// URI to the image'
            },
            maxPx: {
              type: 'number',
              description: 'Maximum dimension in pixels',
              default: 1024
            }
          },
          required: ['uri']
        }
      },
      {
        name: 'render_preview',
        description: 'Render a preview of an image with edit operations applied',
        inputSchema: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'file:// URI to the image'
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
                        maxItems: 4
                      },
                      angleDeg: { type: 'number' },
                      aspect: { type: 'string' }
                    },
                    required: ['id', 'op']
                  }
                }
              },
              required: ['version', 'baseUri', 'ops']
            },
            maxPx: {
              type: 'number',
              description: 'Maximum dimension in pixels for preview',
              default: 1024
            }
          },
          required: ['uri', 'editStack']
        }
      },
      {
        name: 'compute_aspect_rect',
        description: 'Compute maximum inscribed rectangle for given aspect ratio',
        inputSchema: {
          type: 'object',
          properties: {
            width: {
              type: 'number',
              description: 'Image width in pixels'
            },
            height: {
              type: 'number',
              description: 'Image height in pixels'
            },
            aspect: {
              type: 'string',
              description: 'Aspect ratio (e.g., "1:1", "16:9", "square")'
            }
          },
          required: ['width', 'height', 'aspect']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === 'read_image_meta') {
    const { uri } = ReadImageMetaArgsSchema.parse(args);
    
    if (!uri.startsWith('file://')) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Only file:// URIs are supported'
      );
    }
    
    const filePath = fileURLToPath(uri);
    validatePath(filePath);
    
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`
      );
    }
    
    const mimeType = await getMimeType(filePath);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unsupported mime type: ${mimeType}`
      );
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
            text: metaText
          }
        ]
      };
    } catch (error: any) {
      // Re-throw as McpError for consistent error handling
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to read image metadata: ${error.message}`
      );
    }
  }
  
  if (name === 'render_thumbnail') {
    const { uri, maxPx } = RenderThumbnailArgsSchema.parse(args);
    
    if (!uri.startsWith('file://')) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Only file:// URIs are supported'
      );
    }
    
    const filePath = fileURLToPath(uri);
    validatePath(filePath);
    
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`
      );
    }
    
    const mimeType = await getMimeType(filePath);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unsupported mime type: ${mimeType}`
      );
    }
    
    try {
      // Render thumbnail with sharp
      const thumbnail = await sharp(filePath)
        .resize(maxPx, maxPx, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .png() // Always output as PNG for consistency
        .toBuffer();
      
      // Return structured image content directly
      return {
        content: [
          {
            type: 'image',
            data: thumbnail.toString('base64'),
            mimeType: 'image/png'
          }
        ]
      };
    } catch (error: any) {
      // Re-throw as McpError for consistent error handling
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to render thumbnail: ${error.message}`
      );
    }
  }
  
  if (name === 'render_preview') {
    const { uri, editStack, maxPx } = RenderPreviewArgsSchema.parse(args);
    
    if (!uri.startsWith('file://')) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Only file:// URIs are supported'
      );
    }
    
    const filePath = fileURLToPath(uri);
    validatePath(filePath);
    
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`
      );
    }
    
    const mimeType = await getMimeType(filePath);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unsupported mime type: ${mimeType}`
      );
    }
    
    // Compute cache key from stack
    const stackHash = crypto.createHash('sha256')
      .update(JSON.stringify(editStack.ops))
      .digest('hex')
      .substring(0, 16);
    
    const cacheKey = getCacheKey(uri, stackHash, maxPx);
    
    // Check cache
    if (previewCache.has(cacheKey)) {
      const cached = previewCache.get(cacheKey)!;
      return {
        content: [
          {
            type: 'image',
            data: cached.toString('base64'),
            mimeType: 'image/png'
          }
        ]
      };
    }
    
    try {
      let pipeline = sharp(filePath);
      const metadata = await pipeline.metadata();
      const originalWidth = metadata.width || 1;
      const originalHeight = metadata.height || 1;
      
      // Apply operations in order
      for (const op of editStack.ops) {
        if (op.op === 'crop') {
          // Apply rotation first if specified
          if (op.angleDeg !== undefined && op.angleDeg !== 0) {
            pipeline = pipeline.rotate(op.angleDeg, {
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            });
          }
          
          // Apply crop if rect is specified
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
              height: safeHeight
            });
          }
        }
      }
      
      // Resize to preview size
      const preview = await pipeline
        .resize(maxPx, maxPx, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .png()
        .toBuffer();
      
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
            mimeType: 'image/png'
          }
        ]
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to render preview: ${error.message}`
      );
    }
  }
  
  if (name === 'compute_aspect_rect') {
    const { width, height, aspect } = ComputeAspectRectArgsSchema.parse(args);
    
    // Parse aspect ratio
    const keywords: Record<string, string> = {
      'square': '1:1',
      'landscape': '3:2',
      'portrait': '2:3',
      'wide': '16:9',
      'ultrawide': '21:9'
    };
    
    const normalized = keywords[aspect.toLowerCase()] || aspect;
    const match = normalized.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    
    if (!match) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Invalid aspect ratio: ${aspect}`
      );
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
              Number(rectH.toFixed(4))
            ],
            aspect: normalized
          })
        }
      ]
    };
  }
  
  throw new McpError(
    ErrorCode.MethodNotFound,
    `Unknown tool: ${name}`
  );
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