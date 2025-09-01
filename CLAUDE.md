# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: ACP Photo Editor - Phase 0

This is a minimal implementation of the Agent Client Protocol (ACP) with two CLIs:

- **photo-client**: JSON-RPC client over stdio
- **photo-agent**: Responds to initialize → session/new → session/prompt, streams session/update

## Protocol Implementation

The system implements ACP v1 with these specific requirements:

- JSON-RPC 2.0 over stdio only
- Text-only content blocks (no images/audio/tools in Phase 0)
- Client spawns agent process and communicates via stdin/stdout
- Agent must stream "pong" for "ping" prompt, then return stopReason:"end_turn"
- CWD paths must be absolute
- Version mismatch should exit with clear error

## Expected Message Flow

1. **Initialize**: Client sends protocolVersion:1, Agent responds with matching version
2. **Session/new**: Client sends absolute CWD path, Agent returns sessionId
3. **Session/prompt**: Client sends text:"ping", Agent streams update "pong" then end_turn
4. **Session/cancel** (optional): Returns stopReason:"cancelled" without throwing

## Performance Constraints

- First response chunk must arrive within 300ms on local machine
- Deterministic behavior: "ping" always produces exactly one "pong" chunk
- Cross-platform: macOS and Linux support required

## Development Setup

The project structure should follow:

```
/cmd/photo-client/       # CLI entry point
/cmd/photo-agent/        # Agent entry point
/pkg/acp/                # Shared JSON-RPC and ACP types
/pkg/logs/               # NDJSON logging
```

Tech stack options:

- TypeScript with `@zed-industries/agent-client-protocol`
- Rust with `agent-client-protocol` crate

## Testing Requirements

Unit tests must cover:

- JSON-RPC envelope encode/decode with malformed input handling
- Protocol version negotiation (match, down-negotiate, mismatch)
- Prompt handler returning end_turn for "ping"

Integration test must verify:

- Full handshake with protocolVersion==1
- Session creation with absolute CWD
- "ping" → "pong" + end_turn flow
- Cancel during prompt → stopReason:"cancelled"

## CLI Usage

```bash
# Terminal 1
./photo-agent

# Terminal 2
./photo-client --agent ./photo-agent --cwd /abs/path
:ping     # triggers prompt
:cancel   # optional cancel test
```

## Logging

All JSON-RPC messages must be logged to `logs/<timestamp>.ndjson` without redaction.
