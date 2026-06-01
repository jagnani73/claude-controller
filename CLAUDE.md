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
pnpm start                  # Launch built backend + Caddy together (prod run; needs both built)
```

Use `pnpm lint` to verify correctness — not full builds. For TypeScript projects, also run `npx tsc --noEmit -p packages/backend` / `packages/frontend`.

## Architecture

pnpm monorepo with 3 packages:

- **`packages/backend`** — Node.js runtime. Spawns Claude Code via `node-pty` with `--settings` JSON (written to a temp file, not inline) injecting blocking HTTP hooks to a loopback endpoint: `PermissionRequest` (tool approvals + AskUserQuestion) and `PreCompact`/`PostCompact` (compaction). `SessionStart` is *not* HTTP-capable in Claude Code, so the session id is learned by watching `~/.claude/sessions/<pid>.json` (`session-locator.service.ts`) — `Session.id` resolves asynchronously, so use `await session.ready` before relying on it. A `TranscriptWatcher` tails the per-session JSONL transcript (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`) for content. All events normalize into a per-session `SessionBus`, which the WS service forwards as typed messages. `SessionManager` (`session-manager.service.ts`) runs **multiple concurrent sessions**, keyed two ways: by `id` and by `spawnToken` — a token embedded in the hook URL path so an inbound hook POST routes to the right session's `SessionBus`. Dependencies: `node-pty`, `ws`.
- **`packages/frontend`** — React 19 + Vite + Tailwind CSS 4. Mobile-first PWA that renders structured message cards (`AssistantMessage`, `UserMessage`, `ToolCallCard`, `ApprovalCard`, `QuestionCard`) in `MessageStream`. Connects to backend via WebSocket.
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
- Input flows in reverse: phone taps Send → `{type:"input"}` → PTY stdin. Text is wrapped in bracketed-paste (`\x1b[200~…\x1b[201~`) and the submit `\r` is sent separately and **confirmed** against the transcript (resent if the prompt doesn't register) — see `Session.sendInput`/`submitWithConfirmation`, because a trailing `\r` coalesced into a large paste gets stripped. Approvals flow via `{type:"approval_response"}` → `hooks.service.resolveApproval()` which unblocks the pending `PermissionRequest` HTTP response.
- The frontend (`SessionView`/`QueuePanel`) **queues inputs locally** while Claude is busy and dispatches them in order — there is no optimistic echo; the queue is the source of truth for pending prompts.

### AskUserQuestion relay

Claude Code's `AskUserQuestion` is an interactive ink picker, not structured input — so the controller renders it as a `QuestionCard` and drives the CLI's picker over the PTY with **timed keystrokes** (the one place we synthesize navigation rather than relay structured data).

- `QuestionCard` (frontend) renders the questions/options/preview from the tool-call input, collects the answer locally, and sends `{type:"question_response", questions, answers, cancel?}` over WS. `questions`/`answers` are positional; shared shapes (`QuestionSchema`, `AnswerEntry`) live in `common`.
- `question.input.ts` `buildKeystrokes(...)` is a **pure** function translating an answer into a `KeystrokeChunk[]` script (each chunk = bytes + optional `settleMs`). Navigation rules were reverse-engineered from `claude-code-source/` and verified against PTY captures: single-select commits with `Enter` (auto-advances in a batch); multi-select toggles with `Space`; a preview-question note is `n` → type → `Esc` (NOT Enter) → select; a batched call ends on a review screen confirmed with one `Enter`.
- `Session.answerQuestion(chunks, confirm, toolUseId)` paces the writes (`CHUNK_DELAY_MS`, honoring per-chunk `settleMs`), then confirms the answer landed via the bus `tool_result` for that `toolUseId`, resending `Enter` if a multi-select submit raced ink's focus flush. If it never confirms (or the script is empty / dispatch throws), `Session.failQuestion` pushes a synthetic error `tool_result` so the card unlocks instead of stranding the UI.
- The reducer in `MessageStream.tsx` keeps a `results` map so a `tool_result` fuses onto its card regardless of arrival order (live vs. history pagination), and dedupes the eager `approval_request` card against the real `tool_call` (the `pr:` → `toolu_` promotion).
- Pure logic is unit-tested: `buildKeystrokes`, the reducer, and the reload parsers (`question-result.ts`).

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

## Environment

- Root `.env` (read by `scripts/start.ts`): `CONTROLLER_HOST` and `TAILSCALE_IP` are **required**; `FRONTEND_DIST` optional. Copy from `.env.example`.
- Backend loads its own `packages/backend/.env` via dotenv.
- `pnpm start` serves the static frontend bundle + backend behind Caddy (`Caddyfile`) over Tailscale — so both packages must be built first (`pnpm build`).

## Reference: Claude Code Source

`claude-code-source/` contains a copy of the Claude Code CLI source (v2.1.87) for reference — used to understand hook payloads, JSONL entry shape, and the `--settings` inline JSON handling. Key files:

- `src/main.tsx:432-483` — `--settings` inline JSON parsing
- `src/utils/hooks/execHttpHook.ts` — HTTP hook POST contract
- `src/entrypoints/sdk/coreSchemas.ts:380-580` — all hook event payload schemas
- `src/schemas/hooks.ts` — settings.json hook config shape (zod)

Gitignored, not part of the build.
