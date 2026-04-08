# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Claude Controller is a remote control system for Claude Code CLI sessions. It spawns Claude Code in a PTY (pseudo-terminal), parses the terminal output into structured data, and serves a custom React PWA to a phone over WebSocket. This is a **terminal relay** — we never call Claude's API directly. The CLI runs locally using the user's Max plan credits.

Security and transport are handled by Tailscale (WireGuard VPN) + Caddy (TLS). We do not build our own auth, crypto, or transport layer.

## Commands

```bash
pnpm install                # Install all workspace dependencies
pnpm dev:backend            # Build common + start server with tsc-watch
pnpm dev:frontend           # Start Vite dev server (port 4578)
pnpm lint                   # Biome check (lint + imports)
pnpm lint:fix               # Biome check with auto-fix
pnpm format                 # Biome format with auto-fix
pnpm check                  # Lint + format in one pass (preferred)
pnpm build                  # Build all packages
pnpm build:backend          # Build server only
pnpm build:frontend         # Build client only
```

Use `pnpm lint` to verify correctness — not full builds. Only run `pnpm build` when explicitly asked or at the end of a major phase.

## Architecture

pnpm monorepo with 3 packages:

- **`packages/backend`** — Node.js runtime. Spawns Claude Code via `node-pty`, parses terminal output, serves WebSocket API. Built with `tsc`, dev mode via `tsc-watch`. Dependencies: `node-pty`, `ws`.
- **`packages/frontend`** — React 19 + Vite + Tailwind CSS 4. Mobile-first PWA that renders parsed session data (approval cards, diffs, metadata, streaming text). Connects to server via WebSocket.
- **`packages/common`** — Shared TypeScript types used by both backend and frontend. Defines `WsMessage`, `SessionConfig`, `SessionInfo`, `PermissionMode`, `ClaudeModel`. Import as `common` or `common/types`.

Data flows: `Claude Code CLI → PTY (node-pty) → Server (parser) → WebSocket → Client (React PWA)`

User input flows in reverse: phone taps "Approve" → server writes `y\r` to PTY stdin.

## Code Style

- **Biome** handles both linting and formatting (no ESLint, no Prettier). Config is centralized at root `biome.json`.
- 4 spaces, double quotes, semicolons, trailing commas.
- Imports are auto-organized by Biome — `node:` builtins first.
- Use `type` imports (`import type { Foo }`) — enforced by Biome.
- React hooks rules enforced in `packages/client/`.
- Path alias `@/*` maps to `packages/frontend/src/*` in the frontend.

## Key Constraints

- **Never use Agent SDK or call Claude's API directly** — this would incur pay-per-token billing instead of using Max plan credits. We control the CLI process via PTY.
- **Parser must never auto-act** — all actions (approve, deny, commands) require explicit user input from the phone. The parser is read-only.
- **No database** — state is flat JSON files in `data/` or in-memory.
- **Shared types go in `packages/common`** — both server and client import from there.
- Root `tsconfig.json` is the shared base — packages extend it.

## Reference: Claude Code Source

`claude-code-source/` contains a copy of the Claude Code CLI source (v2.1.87) for reference — used to understand terminal output patterns (spinner verbs, status bar format, special markers). Gitignored, not part of the build.
