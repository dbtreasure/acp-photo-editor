# ACP Photo Editor — Phase 1

An implementation of the Agent Client Protocol (ACP) with support for image resource links.

## Quick Start

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run the demo (ping-pong test)
npm run demo

# Run interactive mode
npm run interactive
```

## What This Is

Phase 1 implements the ACP protocol with image resource support:
1. **Initialize** - Protocol version negotiation
2. **Session/new** - Create a session with workspace
3. **Session/prompt** - Send prompts with text and resource_links
4. **Session/update** - Stream agent responses
5. **Resource Links** - Pass image file references to the agent

## Demo Script

### Basic Demo (Golden Path)
```bash
# Terminal 1 - Start the agent
npm run start:agent

# Terminal 2 - Run the client
npm run start:client

# Or run the automated demo
npm run demo
```

Expected output:
```
DEMO:INIT:OK {"protocolVersion":1,"agentCapabilities":...}
DEMO:SESSION sess_abc123
DEMO:CHUNK pong
DEMO:STOP end_turn
```

### Interactive Mode
```bash
npm run interactive

# Available commands:
# :ping            - Send a ping message to the agent
# :open <path...>  - Open image file(s)
# :cancel          - Cancel the current prompt
# :exit            - Exit the client
```

### Opening Images (Phase 1)
```bash
npm run interactive

> :open /path/to/image.jpg /path/to/photo.png

# The client will:
# 1. Convert paths to file:// URIs
# 2. Guess MIME types (image/jpeg, image/png, image/x-raw, etc.)
# 3. Send resource_links in the prompt
# 4. Display a table of resources and their status

# Example output:
Resources:
Name          URI                         MIME          Status
----          ---                         ----          ------
image.jpg     .../path/to/image.jpg      image/jpeg    SENDING
photo.png     .../path/to/photo.png      image/png     SENDING

[agent] ack: 2 resources (image.jpg, ...)

[result] stopReason: end_turn
```

## Project Structure

```
/cmd/           # CLI entry points
  photo-client.ts   # ACP Client with :open command
  photo-agent.ts    # ACP Agent with resource acknowledgment
/src/
  /acp/         # ACP protocol types (includes ContentBlockResourceLink)
  /common/      # JSON-RPC, logging, and MIME type utilities
/test/          # Integration tests
/logs/          # Runtime NDJSON logs
/transcripts/   # Example protocol messages
```

## Protocol Messages

Example transcripts are provided in `/transcripts/`:
- `initialize.ndjson` - Protocol version negotiation
- `session_new.ndjson` - Session creation
- `prompt_ping.ndjson` - Ping-pong exchange
- `cancel.ndjson` - Cancellation flow
- `phase1_open_resource_link.ndjson` - Resource link handling

## Testing

```bash
# Run all tests
npm test

# The demo itself is an integration test
npm run demo
```

## Logging

All JSON-RPC messages are logged to `logs/` directory as NDJSON files:
- `client-<timestamp>.ndjson` - Client-side messages
- `agent-<timestamp>.ndjson` - Agent-side messages

## Development

### Commands
- `npm run build` - Compile TypeScript
- `npm run clean` - Clean build artifacts and logs
- `npm test` - Run tests
- `npm run demo` - Run ping-pong demo
- `npm run interactive` - Interactive REPL mode

### Requirements
- Node.js 18+ 
- TypeScript 5+
- macOS or Linux

## CI/CD

GitHub Actions workflow runs on push/PR:
- Lint (TypeScript check)
- Build
- Unit tests
- Integration test (demo)

Tested on macOS and Linux with Node 18.x and 20.x.

## Phase 1 Features

✅ Implemented:
- JSON-RPC 2.0 over stdio
- Initialize handshake
- Session management
- Text prompts and resource_links
- :open command for image files
- MIME type detection for images (JPEG, PNG, RAW formats)
- Resource acknowledgment by agent
- Streaming updates
- NDJSON logging
- Interactive CLI with :ping, :open, and :cancel

🎯 Supported Image Formats:
- Standard: JPEG, PNG, GIF, WebP, BMP, SVG
- RAW: RAF (Fuji), NEF (Nikon), ARW (Sony), CR2/CR3 (Canon), DNG (Adobe), ORF (Olympus), RW2 (Panasonic)

❌ Not Yet Implemented:
- Actual image pixel data processing
- Tool calls
- File system access beyond URIs
- MCP servers
- Audio support
- Plans
- Permissions

## License

MIT