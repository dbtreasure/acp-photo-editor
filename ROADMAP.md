# ACP Photo Editor — Roadmap

## Current Status: Phase 7e Complete ✅

We've successfully implemented intelligent photo editing capabilities through the Agent Client Protocol (ACP) with Model Context Protocol (MCP) integration, powered by Google's Gemini 2.5 Flash model.

### Completed Phases

#### Phase 0-6: Foundation
- ✅ **Phase 0**: Basic ACP implementation with JSON-RPC over stdio
- ✅ **Phase 1-3**: Core editing operations (crop, white balance, exposure, contrast)
- ✅ **Phase 4-5**: Color adjustments (saturation, vibrance)
- ✅ **Phase 6**: Export and histogram capabilities

#### Phase 7: AI-Powered Editing (Gemini Integration)

##### ✅ Phase 7a: Natural Language Processing
- Basic :ask command with mock planner
- Natural language to operation mapping

##### ✅ Phase 7b: Gemini Planner Integration
- Gemini 2.5 Flash integration with structured JSON output
- Automatic fallback to mock planner
- Smart value clamping and validation

##### ✅ Phase 7c: Vision-Lite (WB Only)
- Vision capabilities for white balance correction
- Image analysis with --with-image flag
- Coordinate mapping for gray point selection

##### ✅ Phase 7d: Vision + Full Tool Catalog
- Complete tool catalog available in vision mode
- Intelligent exposure, contrast, and composition analysis
- Horizon detection and rotation suggestions
- Single-turn edit-to-export workflows

##### ✅ Phase 7e: Reference-Look Match (Global Only)
- **Status**: COMPLETE (just implemented)
- Match reference image characteristics using global operations
- LAB color space statistics computation
- Local, deterministic delta calculations
- 70/30 vibrance/saturation split for skin tone protection
- Epsilon suppression for micro-adjustments
- Full telemetry with specialized spans

---

## Upcoming Phases

### Phase 7f — Clarify/Confirm (Single Follow-up)

**Goal**: Allow one planner question when intent is ambiguous, or show a "plan → confirm" before apply.

**Why**: Reduces bad edits while keeping interaction simple.

**Scope**:
- In: `:ask --confirm` mode; agent can issue ACP `request_input()` for clarification
- Out: Infinite dialog trees (keep it to single follow-up)

**Implementation**:
- Agent can request clarification once per turn
- Preview plan before applying with user confirmation
- Cap at 1 follow-up question

**CLI Example**:
```bash
:ask --confirm --with-image "give it a cinematic punch"
# Agent prints plan summary → waits → :yes / :no / answer text
```

**Acceptance Criteria**:
- If ambiguous, planner emits question
- Agent renders plan preview only after confirm
- Trace shows `confirm.request` + `decision`

---

### Phase 7g — ROI Boxes (Local-Lite)

**Goal**: Local adjustments via rectangular ROIs (feathered), no ML segmentation.

**Why**: Unlock "subject brighter, background cooler" without heavy infrastructure.

**Scope**:
- In: New ops `local_adjust({roi:[x,y,w,h], ev?, contrast?, saturation?, vibrance?})`
- ROI in preview-normalized coordinates
- MCP applies with soft mask
- Planner may propose 0–2 ROIs (subject/background)
- Out: Brush strokes, semantic masks

**Implementation**:
- Rectangular regions with feathered edges
- Support for multiple ROIs per operation
- Coordinate mapping under rotation/crop

**CLI Example**:
```bash
:ask --with-image "brighten subject a touch, mute background colors"
```

**Acceptance Criteria**:
- Single preview render
- Stack shows `Local(roi#1 ev +0.3) • Local(roi#2 saturation -20)`
- ROI mapping/clamp tests pass under rotate/crop

---

### Phase 7h — Named Looks (Macro Expansion)

**Goal**: Map style names to deterministic macro recipes using existing ops.

**Why**: Fast UX win, model-agnostic presets.

**Scope**:
- In: Catalog `looks.json` with named presets
  - Example: `"teal_orange_mild" → {wb:+10, contrast:+15, saturation:+8, vibrance:+12}`
- Planner picks label; agent expands to normal ops
- Out: Per-image learned curves

**Implementation**:
- JSON catalog of named looks
- Deterministic expansion to operation sequences
- Planner selects appropriate look based on request

**CLI Example**:
```bash
:ask "apply a mild teal-orange look"
```

**Acceptance Criteria**:
- Planner returns `apply_look("teal_orange_mild")`
- Agent expands to ≤6 ops
- Single preview
- Trace records `look.name`

---

### Phase 7i — Robustness & Cost Controls

**Goal**: Make planner calls snappy and economical.

**Why**: Production readiness and user experience.

**Scope**:
- JSON-mode schema enforcement
- `--planner-timeout` race + fallback metrics
- Call budgeting (`--planner-max-calls` hard trim)
- Preview JPEG size governance
- Provider failover (mock → gemini → alt)
- Golden transcript testing

**Implementation**:
- Timeout racing with fallback
- Hard limits on operations per request
- Optimized preview generation
- Comprehensive golden tests

**Acceptance Criteria**:
- Planner p50 ≤1.2s on 1024px previews
- Fallback rate ≤1%
- Golden tests green

---

## Implementation Order & Dependencies

### Recommended Sequence:
1. **7f (Confirm)** — UX/ACP flow enhancement, no new pixel work
2. **7g (ROI)** — Introduces one new op + simple mask compositor
3. **7h (Looks)** — Can land anytime, pure agent/planner work
4. **7i (Robustness)** — Run in parallel as hardening effort

### Dependencies:
- 7e ✅ (reference) — Complete, uses only global ops + image_stats
- 7f builds on existing planner infrastructure
- 7g requires new MCP tool support for local adjustments
- 7h is independent after 7d
- 7i is ongoing optimization work

---

## Telemetry Plan

### New Attributes to Add:
- **7f**: `confirm.requested`, `confirm.answer`
- **7g**: `roi.count`, `roi.sizes`, `roi.overlaps`
- **7h**: `look.name`, `look.ops_count`
- **7i**: `fallback.reason`, `timeout.exceeded`

### New Counters:
- `planner_questions_total`
- `roi_ops_total`
- `look_apply_total`
- `planner_fallback_total`
- `planner_timeout_total`

### Existing Enhanced:
- Continue tracing all operations with timing
- Maintain span hierarchy for debugging
- Keep privacy-safe logging (basenames only)

---

## Success Metrics

### Performance:
- Single preview per turn maintained
- Planner latency p50 < 1.2s, p99 < 3s
- Local delta computation < 1ms
- ROI application < 100ms per region

### Quality:
- Reference matching within perceptual thresholds
- ROI feathering smooth and artifact-free
- Named looks produce consistent results
- Fallback behavior transparent to users

### Reliability:
- Planner fallback rate < 1%
- Deterministic delta computation
- Graceful timeout handling
- Golden test coverage > 90%

---

## Phase 8 — Ink TUI (Terminal UI Evolution)

**Goal**: Transform the CLI into a React-based Terminal UI using Ink, providing a desktop-app-like experience while maintaining full ACP/MCP architecture.

**Why**: Ink provides a perfect bridge between CLI and full GUI—keeping terminal deployment while adding rich interactivity, panels, and visual feedback inspired by Claude Code's Ink-based interface.

### What Ink Provides
- **React mental model + Flexbox layout** via Yoga for easy panels and resizable regions
- **TUI-specific hooks**: `useInput` (keybindings), `useFocus`, `useStdout`
- **Ready-made widgets**: inputs, selects, spinners, tables via community packages (`@inkjs/ui`, `ink-select-input`, `ink-text-input`, `ink-table`)
- **Terminal-aware sizing** (`ink-use-stdout-dimensions`) for responsive layout

### Image Display Strategy
- **Keep iTerm2 inline-image approach**: Write OSC 1337 escapes inside Ink components
- **Terminal capability detection**: Prefer iTerm2/Kitty images → fall back to block/ASCII in others
- **Use helpers**: `terminal-image` or `term-img` for cross-terminal support
- **Note**: iTerm2's protocol is proprietary; tmux has quirks—detect and degrade gracefully

### Claude Code UX Patterns to Adopt

#### Three-Pane Layout (Ink Flexbox)
- **Left**: Resources & Sessions (files, recent exports)
- **Center**: Image Preview (inline image)
- **Right**: Controls (sliders for WB/EV/Contrast/Vibrance, crop buttons)
- **Bottom**: Chat/Command bar + status line (model, fps, trace id)

#### Plan → Preview → Apply Flow
- User chats "warm it up, lift shadows"
- Show Claude-style plan list (checkable items)
- Render preview
- Apply to stack on confirm
- Reflect changes by moving sliders in control pane

#### Command Palette & Slash Commands
- `⌘K`/`Ctrl-K` opens palette of actions (`:wb`, `:exposure`, `:auto`)
- Use `ink-select-input` + `ink-text-input` with `useInput` for bindings

#### Streaming & Progress
- Use `@inkjs/ui` components and `<Static>` for long-lived logs
- Export progress with spinners
- Tables & histograms with `ink-table` and ASCII sparklines

#### Responsive Design
- Adjust panels to terminal size with `useStdoutDimensions`
- Hide panels under keybindings when width constrained
- Status line showing session, model, fps, and Jaeger trace links

### Architecture Integration

**No protocol changes needed**:
- Keep `photo-agent` exactly as is
- New Ink `photo-tui` replaces current thin client
- Still speaks ACP/JSON-RPC over stdio

**Implementation mapping**:
- Streaming updates → React state via `session/update`
- MCP tools/permissions → Modal panes
- Batch ops → Checklist visualization
- Telemetry → Inline trace IDs and spinners

### MVP Implementation Plan

1. **Scaffold photo-tui** (Ink app) with main layout and panes
2. **Preview component** using `terminal-image` (JPEG 80 at 1024px)
3. **Stack panel**: Live list with keybindings (`u` undo, `r` redo, `⌫` remove)
4. **Controls panel**: WB/EV/Contrast sliders with arrow key navigation
5. **Chat/Ask bar** mirroring `:ask --with-image` flow
6. **Status line**: session/model/fps/trace id (toggle with `s`)
7. **Headless guard**: Detect non-TTY and provide fallback

### Nice-to-Have Features
- **Gallery grid**: Thumbnails using inline images
- **Plan inspector**: Show planned MCP calls as checkable table
- **Keyboard help**: `?` shows all bindings
- **Trace viewer**: `t` prints span names/durations inline

### Technical Considerations
- **Terminal-specific image support**: iTerm2/Kitty excellent; tmux may truncate
- **Interactive TTY required**: Provide `--headless` mode for CI
- **Raw-mode limitations**: Ink expects stdin control

### Timeline
- **Phase 8 MVP**: 1 week (basic TUI with core features)
- **Phase 8 Complete**: 2-3 weeks (full feature parity + enhancements)

---

## Future Considerations (Phase 9+)

### Potential Extensions:
- **Curves & Tone Mapping**: Advanced color grading tools
- **ML Segmentation**: Semantic masks for sky, skin, etc.
- **Multi-Reference Blending**: Combine looks from multiple references
- **Batch Processing**: Apply edits to multiple images
- **Plugin Architecture**: Extensible operation system
- **Cloud Sync**: Settings and looks synchronization
- **Native GUI**: Electron or Tauri wrapper around Ink TUI

### Technical Debt to Address:
- Optimize LAB conversion performance
- Implement proper color management (ICC profiles)
- Add undo/redo persistence across sessions
- Improve preview caching strategy

---

## Contributing

When implementing new phases:
1. Create detailed PRD following 7d/7e format
2. Implement with comprehensive tests
3. Update telemetry spans
4. Document in README
5. Add golden transcripts
6. Ensure single preview rule maintained

---

## Timeline Estimates

### Phase 7 (AI-Powered Editing)
- **Phase 7f**: 2-3 days (UX flow, minimal pixel work)
- **Phase 7g**: 4-5 days (ROI implementation, feathering)
- **Phase 7h**: 1-2 days (catalog + expansion logic)
- **Phase 7i**: Ongoing (parallel hardening)

Total to complete Phase 7: ~2 weeks

### Phase 8 (Ink TUI)
- **MVP**: 1 week (basic TUI with core features)
- **Complete**: 2-3 weeks (full feature parity + enhancements)

### Overall Timeline
- **Phase 7 completion**: 2 weeks
- **Phase 8 TUI**: 3 weeks
- **Total to modern TUI**: ~5 weeks

---

*Last Updated: September 2025*
*Current Version: Phase 7e*