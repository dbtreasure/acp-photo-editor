# ACP Photo Editor — Phase 3

An implementation of the Agent Client Protocol (ACP) with Model Context Protocol (MCP) integration for real image processing, now with non-destructive edit stack and crop/straighten operations.

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

## What's New in Phase 3

Phase 3 adds non-destructive edit stack with crop/straighten operations:
- **Edit Stack v1**: Non-destructive edit operations stored per image
- **Crop & Straighten**: Apply crop with aspect ratios and rotation angles
- **Undo/Redo**: Full undo/redo support with edit history
- **Live Previews**: Real-time preview generation with edits applied
- **Amend-Last**: Smart operation replacement to prevent stack bloat
- **Cache Optimization**: Cached image decoding and preview rendering

Previous Phase 2 features:
- **MCP Image Server**: Standalone server for image operations
- **Real Thumbnails**: Generate actual image thumbnails (1024px max)
- **Metadata Extraction**: Get dimensions, file size, MIME type
- **Tool Call Streaming**: Progressive updates with tool_call_update
- **iTerm2 Support**: Inline image display in compatible terminals

## Edit Commands

### Crop & Straighten
- `:crop --aspect 1:1` - Crop to aspect ratio (square, 16:9, 3:2, etc)
- `:crop --rect 0.1,0.1,0.8,0.8` - Crop to normalized rectangle
- `:crop --angle -2.5` - Rotate/straighten by degrees
- `:crop --aspect 16:9 --angle 1.0` - Combined operations

### Edit History
- `:undo` - Undo last edit operation
- `:redo` - Redo previously undone operation  
- `:reset` - Clear all edits

### File Operations
- `:open <path>` - Load image file(s)
- `:gallery` - Show loaded thumbnails

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

# Load an image
> :open test/assets/test-landscape.jpg

Opening resources...
[metadata:img_1] test-landscape.jpg 1024×768, 1.2MB, image/jpeg +EXIF
[thumbnail:img_1] Received image/png (45KB)
[iTerm2] Displayed inline: test-landscape.jpg
[completed:img_1]

# Apply a square crop
> :crop --aspect 1:1

Executing :crop...
[edit_preview] Stack: 1 ops | Last: crop aspect=1:1
[edit_preview] Received image/png (32KB)
[iTerm2] Displayed inline preview
[completed:edit_preview]

# Straighten the image
> :crop --angle -2.5

Executing :crop...
[edit_preview] Stack: 1 ops | Last: crop angle=-2.5°
[edit_preview] Received image/png (35KB)
[completed:edit_preview]

# Undo last operation
> :undo

Executing :undo...
[edit_preview] Stack: 0 ops | Last: No operations
[edit_preview] Received original preview

# Apply combined operation
> :crop --aspect 16:9 --angle 1.0

Executing :crop...
[edit_preview] Stack: 1 ops | Last: crop aspect=16:9 angle=1.0°
[completed:edit_preview]

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

### CLI Options

- `--tty-images=auto|iterm|off` - Control inline image display
  - `auto` (default): Auto-detect iTerm2
  - `iterm`: Force iTerm2 mode
  - `off`: Disable inline images
- `--interactive` or `-i` - Start in interactive mode
- `--agent <cmd>` - Specify agent command
- `--cwd <path>` - Set working directory

## MCP Server Features

The MCP image server (`cmd/mcp-image-server.ts`) provides:

### Resources
- `file://` URI scheme support
- Bounded to current working directory
- Path traversal protection

### Tools

1. **read_image_meta(uri)** - Extract image metadata
   - Returns human-readable text: "filename.jpg 1024×768, 1.2MB, image/jpeg +EXIF"

2. **render_thumbnail(uri, maxPx)** - Generate thumbnail
   - Returns base64-encoded PNG
   - Preserves aspect ratio
   - Default max dimension: 1024px

3. **render_preview(uri, editStack, maxPx)** - Apply edits and generate preview
   - Accepts edit stack with crop/rotate operations
   - Returns base64-encoded PNG with edits applied (crop then rotate)
   - Cached for performance
   - Default max dimension: 1024px

4. **compute_aspect_rect(width, height, aspect)** - Calculate crop rectangle
   - Computes maximum inscribed rectangle for aspect ratio
   - Returns normalized coordinates [0,1]
   - Supports keywords: square, landscape, portrait, wide, ultrawide

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

## Phase 2a Features

✅ Phase 2:
- MCP server with Resources and Tools
- Real image metadata extraction
- Thumbnail generation with Sharp
- Tool call streaming (tool_call_update)
- Progressive content updates
- Gallery view in client
- Graceful fallback to Phase 1

✅ Phase 2a (iTerm2 Support):
- Automatic iTerm2 terminal detection
- OSC 1337 inline image protocol
- Tmux-safe multipart transfer (1MB chunks)
- 64ch default width with aspect ratio preservation
- WezTerm compatibility
- Configurable via --tty-images flag

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