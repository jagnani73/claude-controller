# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Claude Controller is a remote control system for Claude Code CLI sessions. It spawns Claude Code in a PTY (pseudo-terminal) with hooks configured, consumes two structured data sources — HTTP hooks + transcript JSONL tail — and serves a custom React PWA to a phone over WebSocket. This is a **terminal relay**; we never call Claude's API directly. The CLI runs locally using the user's Max plan credits.

Security and transport are handled by Tailscale (WireGuard VPN) + Caddy (TLS). We do not build our own auth, crypto, or transport layer.

## Commands

```bash
pnpm install                # Install all workspace dependencies
pnpm dev:backend            # Build common + start server with tsc-watch
pnpm dev:frontend           # Start Vite dev server (port 4578)
pnpm lint                   # Biome check (lint + imports)
pnpm lint:fix               # Biome check with auto-fix
pnpm check                  # Lint + format in one pass (preferred)
pnpm build                  # Build all packages
pnpm build:backend          # Build backend only
pnpm build:frontend         # Build frontend only
```

Use `pnpm lint` to verify correctness — not full builds. For TypeScript projects, also run `npx tsc --noEmit -p packages/backend` / `packages/frontend`.

## Architecture

pnpm monorepo with 3 packages:

- **`packages/backend`** — Node.js runtime. Spawns Claude Code via `node-pty` with `--settings '{"hooks":{...}}'` inline JSON injecting two HTTP hooks (`SessionStart`, `PermissionRequest`) to a loopback endpoint. A `TranscriptWatcher` tails the per-session JSONL transcript (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`) for content. All events normalize into a per-session `SessionBus`, which the WS service forwards as typed messages. Dependencies: `node-pty`, `ws`.
- **`packages/frontend`** — React 19 + Vite + Tailwind CSS 4. Mobile-first PWA that renders structured message cards (`AssistantMessage`, `UserMessage`, `ToolCallCard`, `ApprovalCard`) in `MessageStream`. Connects to backend via WebSocket.
- **`packages/common`** — Shared TypeScript types used by both backend and frontend. Defines `ServerMessage`, `ClientMessage` (typed WS protocol), `SessionConfig`, `SessionInfo`, `PermissionMode`, `ClaudeModel`, `EffortLevel`. Import as `common` or `common/types`.

### Data flow

```
Phone ──▶ WebSocket ──▶ Backend ──▶ PTY stdin (input only)
                           │
                           └── Claude Code CLI
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
              Hook HTTP POSTs                transcript.jsonl
              (loopback-only)                (tailed by fs.watch)
                    │                               │
                    ▼                               ▼
               hooks.service               transcript.service
                    │                               │
                    └──────────────┬────────────────┘
                                   ▼
                               SessionBus
                                   │
                                   ▼
                              ws.service ──▶ typed WsMessage ──▶ Phone
```

- PTY stdout is captured to `data/captures/<session>.raw` for debugging only — nothing parses it.
- Input flows in reverse: phone taps Send → `{type:"input"}` → PTY stdin (`text\r`). Approvals flow via `{type:"approval_response"}` → `hooks.service.resolveApproval()` which unblocks the pending `PermissionRequest` HTTP response.

## Code Style

- **Biome** handles both linting and formatting (no ESLint, no Prettier). Config is centralized at root `biome.json`.
- 2 spaces, double quotes, semicolons, trailing commas, line width 100.
- Imports are auto-organized — `node:` builtins first.
- Use `type` imports (`import type { Foo }`) — enforced.
- React hooks rules enforced globally.
- Path alias `@/*` maps to `packages/frontend/src/*` in the frontend.

## Key Constraints

- **Never use Agent SDK or call Claude's API directly** — that would incur pay-per-token billing instead of using Max plan credits. We control the CLI process via PTY.
- **No regex parsing of PTY output** — content comes from hooks + JSONL tail. The PTY `.raw` dump exists only for debugging.
- **Hook listener is loopback-only** (`127.0.0.1`) — Claude Code's SSRF guard blocks private IPs, and there's no reason for this endpoint to be reachable over the network.
- **No database** — state is in-memory; sessions don't survive backend restart.
- **Shared types go in `packages/common`** — both backend and frontend import from there.
- Root `tsconfig.json` is the shared base — packages extend it.

## Reference: Claude Code Source

`claude-code-source/` contains a copy of the Claude Code CLI source (v2.1.87) for reference — used to understand hook payloads, JSONL entry shape, and the `--settings` inline JSON handling. Key files:

- `src/main.tsx:432-483` — `--settings` inline JSON parsing
- `src/utils/hooks/execHttpHook.ts` — HTTP hook POST contract
- `src/entrypoints/sdk/coreSchemas.ts:380-580` — all hook event payload schemas
- `src/schemas/hooks.ts` — settings.json hook config shape (zod)

Gitignored, not part of the build.
