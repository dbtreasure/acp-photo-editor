# ACP Photo Editor — Phase 0

A minimal implementation of the Agent Client Protocol (ACP) demonstrating the handshake and basic message flow.

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

Phase 0 implements the core ACP protocol flow:
1. **Initialize** - Protocol version negotiation
2. **Session/new** - Create a session with workspace
3. **Session/prompt** - Send "ping" and receive "pong"
4. **Session/update** - Stream agent responses

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
# :ping    - Send a ping message to the agent
# :cancel  - Cancel the current prompt
# :exit    - Exit the client
```

## Project Structure

```
/cmd/           # CLI entry points
  photo-client.ts   # ACP Client implementation
  photo-agent.ts    # ACP Agent implementation
/src/
  /acp/         # ACP protocol types
  /common/      # JSON-RPC and logging utilities
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

## Phase 0 Scope

✅ Implemented:
- JSON-RPC 2.0 over stdio
- Initialize handshake
- Session management
- Text-only prompts
- Streaming updates
- NDJSON logging
- Interactive CLI with :ping and :cancel

❌ Not in Phase 0:
- Tool calls
- File system access
- MCP servers
- Images/audio
- Plans
- Permissions

## License

MIT