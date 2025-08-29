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

// Use MCP_ROOT from environment for proper session sandboxing
const root = process.env.MCP_ROOT || process.cwd();

const ReadImageMetaArgsSchema = z.object({
  uri: z.url()
});

const RenderThumbnailArgsSchema = z.object({
  uri: z.url(),
  maxPx: z.number().int().positive().default(1024)
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