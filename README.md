# ACP Photo Editor — Phase 7d

An implementation of the Agent Client Protocol (ACP) with Model Context Protocol (MCP) integration for real image processing, now featuring **full vision-enabled AI editing** that can analyze images to make intelligent corrections across the entire tool catalog using Google's Gemini 2.5 Flash model.

## Quick Start

```bash
# Requires Node.js >= 20.0.0 (for @google/genai compatibility)
# If using nvm:
nvm use 24  # or 20, 22

# Install dependencies
npm install

# Build the project
npm run build

# Run interactive mode with Gemini planner
GEMINI_API_KEY=your-api-key npm run interactive -- --planner=gemini

# Run with mock planner (no API key required)
npm run interactive

# Run the demo
npm run demo
```

## What's New in Phase 7d

Phase 7d extends vision capabilities to the **full tool catalog** for comprehensive AI-powered editing:

- **Full Tool Catalog**: All operations now available in vision mode (WB, exposure, contrast, saturation, vibrance, rotate, crop, export)
- **Intelligent Analysis**: AI analyzes images to suggest exposure, contrast, composition improvements
- **Smart Cropping**: Visual composition analysis for better crop suggestions
- **Horizon Detection**: Automatic rotation suggestions for tilted horizons
- **Single-Turn Export**: Complete edit-to-export workflows in one command
- **Enhanced Mapping**: Coordinate mapping for both gray points and crop rectangles
- **Complete OTEL/Jaeger**: End-to-end tracing across all operations

### Previous Phase 7b Features

- **Gemini Planner**: Uses Google's Gemini 2.5 Flash model for NLP
- **Structured Output**: JSON Schema validation ensures reliable responses
- **Automatic Fallback**: Falls back to MockPlanner on errors/timeout
- **Smart Clamping**: Server-side validation and range enforcement
- **Telemetry**: Comprehensive logging of planner operations
- **Configuration**: Flexible timeout, model, and call limits

### Planner Configuration

```bash
# Use Gemini planner (requires GEMINI_API_KEY environment variable)
./photo-client --planner=gemini

# Additional options
--planner-model=gemini-2.5-flash  # Model selection
--planner-timeout=2000             # Timeout in ms (default: 2000)
--planner-max-calls=6              # Max operations per request
--planner-log-text                 # Log user text for debugging

# Disable planner
./photo-client --planner=off
```

### Example Commands

#### Vision Mode (Phase 7d - Full Catalog)

With `--with-image`, the AI can see your image and make comprehensive intelligent corrections:

```bash
:ask --with-image "fix white balance, brighten slightly, add contrast, crop to 16:9, export as final.jpg"
:ask --with-image "neutralize the blue cast, lift shadows, make it warmer, square crop, export PNG"
:ask --with-image "correct the colors and straighten the horizon, export high quality"
:ask --with-image "enhance this portrait - better skin tones, softer contrast, tighter crop"
```

The vision planner will:

- Analyze the image for color casts, exposure issues, and composition
- Identify neutral references for white balance correction
- Detect tilted horizons and suggest rotation angles
- Recommend crops based on composition and subject matter
- Apply saturation/vibrance intelligently based on content
- Execute complete workflows including export in a single turn

#### Text Mode (Phase 7b)

Natural language editing without vision still works for all operations:

- `:ask "make it warmer and brighter with more contrast"`
- `:ask "cool tones, lift shadows, crop to 16:9 for video"`
- `:ask "enhance colors with more vibrance, straighten horizon"`
- `:ask "black and white with high contrast, square crop"`
- `:ask "export to ./finals/hero.jpg at 95% quality"`

The Gemini planner intelligently:

- Interprets semantic meaning ("warmer" → temp adjustment)
- Applies appropriate values based on context
- Handles multiple operations in logical order
- Validates and clamps all values to safe ranges

### New Operations in Phase 7d

**Color Enhancement:**
- `set_saturation`: Adjust color intensity (-100 to 100, -100 = B&W)
- `set_vibrance`: Smart saturation that protects skin tones

**Geometry:**
- `set_rotate`: Straighten horizons (-45 to 45 degrees)
- Enhanced `set_crop`: Now supports rectNorm for precise cropping

**Complete Workflows:**
- Single-turn operations from edit to export
- Vision-guided automatic adjustments
- Coordinate mapping for all spatial operations

## Observability & Debugging (NEW!)

The project now includes comprehensive OpenTelemetry-based observability for debugging LLM workflows:

### Setup Jaeger for Trace Visualization
```bash
# Start Jaeger using Docker
docker-compose up -d

# Access Jaeger UI
open http://localhost:16686
```

### Enable Tracing
```bash
# Run with tracing enabled
OTEL_ENABLED=true npm run interactive -- --planner=gemini

# With debug output
OTEL_ENABLED=true OTEL_DEBUG=true npm run interactive -- --planner=gemini
```

### Debug Traces
```bash
# View latest trace in console
node scripts/debug-trace.js

# View specific trace
node scripts/debug-trace.js <trace-id>
```

### What's Traced
- **Image Operations**: Load, preview generation, base64 encoding
- **Planner Execution**: API calls, response parsing, validation
- **Edit Operations**: White balance, coordinate mapping, stack updates
- **Performance Metrics**: Latency per operation, token usage

### Benefits
- **Immediate Visibility**: See exactly where failures occur (e.g., response format issues)
- **Performance Analysis**: Identify bottlenecks in multi-step workflows
- **Historical Comparison**: Compare successful vs failed runs
- **Correlation IDs**: Automatic trace IDs in all log entries

## Phase 7 Roadmap

- **7a**: MockPlanner with deterministic text → ops ✅
- **7b**: Gemini 2.5 Flash integration (text-only) ✅
- **7c (current)**: Vision-lite for WB (1024px preview input) ✅
- **7d**: Full tool catalog + export in single turn

## What's New in Previous Phases

Phase 6 adds advanced color operations and intelligent adjustments:

- **Saturation/Vibrance**: Global color enhancement with smart protection
- **Auto Adjustments**: Intelligent auto white balance, exposure, and contrast
- **Histogram Analysis**: Real-time 64-bin histogram with clipping detection
- **Batch Auto**: Apply all auto adjustments with `:auto all` command
- **ASCII Visualization**: Terminal-friendly histogram sparklines
- **Extended Pipeline**: Proper operation order for all color adjustments

Phase 5 features:

- **White Balance**: Gray point sampling or manual temp/tint adjustment
- **Exposure**: EV-based brightness control (±3 stops)
- **Contrast**: Global contrast adjustment (±100%)
- **Proper Order**: Color ops applied before geometry for correct processing
- **Amend-Last**: Smart replacement of most recent op by type
- **Live Preview**: Real-time preview with all adjustments applied

Phase 4 features:

- **Full Resolution Export**: Write edited images to disk at full quality
- **Permission Gating**: ACP session/request_permission for write operations
- **Sidecar Persistence**: Edit stack saved as .editstack.json alongside exports
- **Atomic Writes**: Temp file + rename pattern prevents partial files
- **Format Options**: JPEG/PNG with quality and chroma subsampling control
- **Progress Streaming**: Real-time export progress via tool_call_update

Phase 3 features:

- **Edit Stack v1**: Non-destructive edit operations stored per image
- **Crop & Straighten**: Apply crop with aspect ratios and rotation angles
- **Undo/Redo**: Full undo/redo support with edit history
- **Live Previews**: Real-time preview generation with edits applied

Previous Phase 2 features:

- **MCP Image Server**: Standalone server for image operations
- **Real Thumbnails**: Generate actual image thumbnails (1024px max)
- **Metadata Extraction**: Get dimensions, file size, MIME type
- **Tool Call Streaming**: Progressive updates with tool_call_update
- **iTerm2 Support**: Inline image display in compatible terminals

## Edit Commands

### Color & Tonal Adjustments

- `:wb --gray 0.42,0.37` - White balance using gray point (normalized coords)
- `:wb --temp 18 --tint -7` - White balance using temperature/tint (-100 to 100)
- `:exposure --ev 0.35` - Adjust exposure in EV stops (-3 to +3)
- `:contrast --amt 12` - Adjust contrast (-100 to 100)
- `:saturation --amt 30` - Adjust color intensity (-100 to 100)
- `:vibrance --amt 40` - Smart saturation that protects skin tones (-100 to 100)

### Auto Adjustments

- `:auto wb` - Automatic white balance using gray-world algorithm
- `:auto ev` - Automatic exposure targeting optimal median brightness
- `:auto contrast` - Automatic contrast based on histogram percentiles
- `:auto all` - Apply all auto adjustments in sequence (WB → EV → Contrast)

### Natural Language Editing (Phase 7a)

- `:ask warmer` - Make image warmer
- `:ask +0.5 ev, more contrast` - Multiple adjustments
- `:ask crop square, straighten 2°` - Crop and rotate
- `:ask cool by 15, contrast -10, 16:9` - Complex edits
- `:ask undo undo redo` - History operations
- `:ask export to output.jpg quality 95` - Export with options

### Analysis Tools

- `:hist` - Display histogram with 64-bin sparklines and clipping percentages

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

### Export Operations

- `:export` - Export with defaults (JPEG 90, ./Export/)
- `:export --format png` - Export as PNG
- `:export --quality 95` - Set JPEG quality
- `:export --dst ./output.jpg` - Specify destination
- `:export --overwrite` - Replace existing files

## Architecture

```
┌──────────┐         ACP          ┌─────────┐         MCP          ┌────────────┐
│  Client  │◄──────JSON-RPC──────►│  Agent  │◄──────JSON-RPC──────►│ MCP Server │
│   (CLI)  │        (stdio)        │         │        (stdio)        │   (Image)  │
└──────────┘                       └─────────┘                       └────────────┘
```

## Demo Script

### Phase 7a - Natural Language Editing

```bash
npm run interactive

# Load an image
> :open test/assets/test.jpg

# Use natural language to edit
> :ask warmer, +0.5 ev, more contrast, crop square
Processing: warmer, +0.5 ev, more contrast, crop square
Applied: WB(temp +20 tint +0), EV +0.50, Contrast +20, Crop 1:1
Stack: WB(temp 20 tint 0) • EV +0.50 • Contrast +20 • Crop 1:1
[Preview displayed]

# Complex command with clamping
> :ask cool by 200, ev 10
Processing: cool by 200, ev 10
Applied: WB(temp -100 tint +0), EV +3.00
Clamped: temp -200 → -100, ev 10.0 → 3.0
Stack: WB(temp -100 tint 0) • EV +3.00 • Contrast +20 • Crop 1:1

# Export with natural language
> :ask export to ./Export/final.jpg quality 95
Processing: export to ./Export/final.jpg quality 95
📝 Permission Request:
   Title: Export edited image
   Explanation: Write edited image to final.jpg
Approve? (y/n): y
Export complete: ./Export/final.jpg
```

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

# Adjust white balance using a gray point
> :wb --gray 0.42,0.37

Executing :wb...
[edit_preview] Stack: WB(gray 0.42,0.37)
[edit_preview] Received image/png (45KB)
[iTerm2] Displayed inline preview
[completed:edit_preview]

# Increase exposure
> :exposure --ev 0.35

Executing :exposure...
[edit_preview] Stack: WB(gray 0.42,0.37) • EV +0.35
[edit_preview] Received image/png (46KB)
[completed:edit_preview]

# Add contrast
> :contrast --amt 12

Executing :contrast...
[edit_preview] Stack: WB(gray 0.42,0.37) • EV +0.35 • Contrast +12
[edit_preview] Received image/png (47KB)
[completed:edit_preview]

# Apply a square crop
> :crop --aspect 1:1 --angle -1.0

Executing :crop...
[edit_preview] Stack: WB(gray 0.42,0.37) • EV +0.35 • Contrast +12 • Crop 1:1 angle -1.0
[edit_preview] Received image/png (32KB)
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
   - Accepts edit stack with all operation types
   - Operation order: color adjustments → geometry (crop/rotate)
   - Color ops: white_balance, exposure, contrast
   - Returns base64-encoded PNG with edits applied
   - Cached for performance
   - Default max dimension: 1024px

4. **compute_aspect_rect(width, height, aspect)** - Calculate crop rectangle
   - Computes maximum inscribed rectangle for aspect ratio
   - Returns normalized coordinates [0,1]
   - Supports keywords: square, landscape, portrait, wide, ultrawide

5. **commit_version(uri, editStack, dstUri, options)** - Export full resolution
   - Renders full-res image with edits applied
   - Atomic write with temp file + rename
   - Format options: JPEG/PNG with quality control
   - Returns: dstUri, bytes, dimensions, elapsed time

6. **compute_histogram(uri, editStack, bins)** - Compute histogram and clipping
   - Generates 64-bin histograms for luma and RGB channels
   - Calculates clipping percentages (pixels at 0 or 255)
   - Applied after color ops, before geometry ops
   - Returns normalized histogram data (0-100 scale)

### Color Adjustment Algorithms

**White Balance**

- Gray Point: Samples pixel at (x,y), calculates RGB scaling to neutralize
- Temp/Tint: Maps [-100,100] to color channel multipliers
- Channel gains clamped to [0.25, 4.0] to prevent extreme corrections

**Exposure**

- Linear scale by 2^EV (e.g., +1 EV = 2× brightness)
- Range: ±3 EV stops
- Applied using Sharp's modulate function

**Contrast**

- Global contrast around mid-tone (0.5 in display space, 128 in 8-bit)
- Linear transformation: (input - 0.5) × factor + 0.5
- Range: ±100% contrast adjustment

**Saturation**

- HSL-based saturation adjustment in sRGB space
- Range: -100 (grayscale) to +100 (2× saturation)
- Preserves hue and lightness, only modifies saturation channel

**Vibrance**

- Intelligent saturation that protects already-saturated colors
- Attenuation factor: k = (1-S)^1.5 for gentle falloff
- Less aggressive than saturation, preserves skin tones better
- Range: ±100% with reduced effect on saturated pixels

### Auto Adjustment Algorithms

**Auto White Balance**

- Gray-world algorithm on 512px downsampled image
- Calculates mean RGB and equalizes to gray
- Gains clamped to [0.5, 2.0] for stability
- Converts to temp/tint parameters for consistency

**Auto Exposure**

- Targets median luma around 0.45 sRGB (~0.18 linear)
- Calculates EV adjustment: log2(target/current)
- Clamped to [-1.5, +1.5] EV to prevent over-correction
- Applied after white balance for accurate analysis

**Auto Contrast**

- Analyzes 2% and 98% luma percentiles
- Calculates stretch factor for dynamic range
- Maps to contrast amount [-40, +40]
- Preserves highlights and shadows while expanding midtones

**Histogram Analysis**

- 64-bin histograms for precise distribution analysis
- Per-channel (R,G,B) and luma computation
- Clipping detection with percentage reporting
- ASCII sparkline visualization for terminal display

### Operation Order

The edit pipeline applies operations in a specific order to ensure correct results:

1. **EXIF Orientation** - Auto-rotate based on metadata
2. **White Balance** - Color temperature correction
3. **Exposure** - Brightness adjustment
4. **Contrast** - Tonal range adjustment
5. **Saturation** - Global color intensity
6. **Vibrance** - Smart saturation
7. **Rotate** - Crop angle rotation
8. **Crop** - Rectangle extraction
9. **Downscale** - Resize for preview/export
10. **Profile/Encode** - Color space and format conversion

This order ensures color adjustments are applied before geometric transformations for optimal quality.

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
