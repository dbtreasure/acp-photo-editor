# ACP Photo Editor — Phase 2

An implementation of the Agent Client Protocol (ACP) with Model Context Protocol (MCP) integration for real image processing.

## Quick Start

```bash
# Requires Node.js >= 18.17.0 (recommended: v20+ or v24+)
# If using nvm:
nvm use 24  # or 20, 22

# Install dependencies
npm install

# Build the project
npm run build

# Run interactive mode with MCP
npm run interactive

# Run the demo
npm run demo
```

## What's New in Phase 2

Phase 2 adds MCP server integration for real image processing:
- **MCP Image Server**: Standalone server for image operations
- **Real Thumbnails**: Generate actual image thumbnails (1024px max)
- **Metadata Extraction**: Get dimensions, file size, MIME type
- **Tool Call Streaming**: Progressive updates with tool_call_update
- **Gallery View**: Display loaded thumbnails in client

## Architecture

```
┌──────────┐         ACP          ┌─────────┐         MCP          ┌────────────┐
│  Client  │◄──────JSON-RPC──────►│  Agent  │◄──────JSON-RPC──────►│ MCP Server │
│   (CLI)  │        (stdio)        │         │        (stdio)        │   (Image)  │
└──────────┘                       └─────────┘                       └────────────┘
```

## Demo Script

### Interactive Mode with Images

```bash
npm run interactive

> :open test/assets/test.jpg

Opening resources...

Resources:
Name        URI                             MIME          Status
----        ---                             ----          ------
test.jpg    ...assets/test.jpg              image/jpeg    SENDING

[metadata] test.jpg 1024×768, 1.2MB, image/jpeg
[thumbnail] Received image/png (45KB)
[completed] img_1

[result] stopReason: end_turn

1 thumbnail(s) loaded. Use :gallery to view.

> :gallery

Thumbnail Gallery:
==================
1. test.jpg 1024×768, 1.2MB, image/jpeg
   Thumbnail: image/png (45KB)
```

### Commands

- `:ping` - Test basic connectivity
- `:open <path...>` - Open and process image files via MCP
- `:gallery` - Display loaded thumbnail information
- `:cancel` - Cancel current operation
- `:exit` - Exit the client

## MCP Server Features

The MCP image server (`cmd/mcp-image-server.ts`) provides:

### Resources
- `file://` URI scheme support
- Bounded to current working directory
- Path traversal protection

### Tools

1. **read_image_meta(uri)** - Extract image metadata
   ```json
   {
     "mime": "image/jpeg",
     "width": 1024,
     "height": 768,
     "sizeBytes": 1234567,
     "exif": { ... }
   }
   ```

2. **render_thumbnail(uri, maxPx)** - Generate thumbnail
   - Returns base64-encoded PNG
   - Preserves aspect ratio
   - Default max dimension: 1024px

### Supported Formats
- Standard: JPEG, PNG, WebP, HEIC/HEIF, TIFF, SVG, GIF
- File size limit: 50MB (configurable)
- EXIF stripping for privacy

## Protocol Flow

1. **Client → Agent**: session/new with mcpServers config
2. **Agent → MCP**: Spawn and connect to image server
3. **Client → Agent**: prompt with resource_links
4. **Agent → MCP**: Call read_image_meta and render_thumbnail
5. **Agent → Client**: Stream tool_call_update events
6. **Agent → Client**: Complete with stopReason: end_turn

## Project Structure

```
/cmd/
  photo-client.ts      # ACP client with thumbnail display
  photo-agent.ts       # ACP agent with MCP client integration
  mcp-image-server.ts  # MCP server for image processing

/src/
  /acp/               # ACP protocol types (extended for Phase 2)
    - ContentBlockImage
    - ToolCallUpdate
    - MCPServerConfig
  /common/            # Shared utilities

/test/
  /assets/            # Test images
  integration.test.ts # Phase 1 tests
  mcp-integration.test.ts # Phase 2 MCP tests
```

## Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm test -- integration.test      # Phase 1 tests
npm test -- mcp-integration.test  # Phase 2 MCP tests

# Test without MCP (fallback to Phase 1)
npm run interactive -- --no-mcp
```

## Performance Targets

- First metadata chunk: < 150ms
- First thumbnail chunk: < 400ms (12MP JPEG @ 1024px)
- Cancel response: < 100ms
- Memory per thumbnail: ≤ 1.5MB

## Troubleshooting

### Sharp Module Errors
If you see "Could not load the sharp module":
```bash
# Check Node version (needs >= 18.17.0)
node --version

# If using nvm, switch to newer version
nvm use 24  # or 20, 22

# Rebuild sharp
npm rebuild sharp
```

### MCP Connection Issues
- Check logs in `logs/` directory
- Test MCP server directly: `npm run start:mcp`
- Verify test image exists: `ls test/assets/`

## Development

### Scripts
- `npm run build` - Compile TypeScript
- `npm run clean` - Clean build artifacts
- `npm run start:agent` - Run agent standalone
- `npm run start:mcp` - Run MCP server standalone
- `npm run interactive` - Interactive client with MCP
- `npm run demo` - Basic ping demo
- `npm run demo:image` - Image processing demo

### Requirements
- Node.js >= 18.17.0 (v20+ or v24+ recommended)
- TypeScript 5+
- macOS or Linux

## Phase 2 Features

✅ Implemented:
- MCP server with Resources and Tools
- Real image metadata extraction
- Thumbnail generation with Sharp
- Tool call streaming (tool_call_update)
- Progressive content updates
- Gallery view in client
- Graceful fallback to Phase 1

🔒 Security:
- CWD-bounded file access
- Path traversal protection
- 50MB file size limit
- EXIF stripping from thumbnails
- MIME type validation

## Next Phase Preview

Phase 3 will add:
- Non-destructive edit operations (crop, rotate)
- Edit history/undo stack
- Permission-gated file writes
- Export with format conversion

## License

MIT