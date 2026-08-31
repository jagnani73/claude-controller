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
- **`packages/frontend`** — React 19 + Vite + Tailwind CSS 4. Mobile-first PWA that renders structured message cards (`AssistantMessage`, `UserMessage`, `ToolCallCard`, `ApprovalCard`, `QuestionCard`) in `MessageStream`. Connects to backend via WebSocket. `AppShell` is a **single responsive shell** keyed off `useIsMobile()` (768px): the `main` panel (wrapping the routed `<Outlet/>`) is rendered unconditionally so SessionView's in-memory queue/draft survive a breakpoint flip, while only the *sidebar presentation* switches — a `react-resizable-panels` docked panel on desktop vs. an off-canvas Sheet drawer on mobile (a resizable split can't satisfy both panels' pixel minimums at phone width). Both presentations share `SidebarShellContext` (`collapsed`/`expand`/`collapse`/`toggle`), so `SessionTopBar`/`HomeView` drive the sidebar the same way regardless of viewport; on mobile `collapsed` is a constant `true` (the hamburger always shows) and the context drives the drawer.
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

- PTY stdout is captured to `dump/captures/<session>.raw` for debugging only — nothing parses it. **Dev-only**: gated on `ServerConfig.capturePty` (`NODE_ENV !== "production"`), written via a long-lived append stream, and skipped entirely in prod.
- **Statusline IPC** (load-bearing, *not* debug): `statusLine` isn't HTTP-hookable, so Claude Code is spawned with `node packages/backend/scripts/statusline-dump.cjs <payloadFile>` as its `statusLine.command` (committed script, resolved relative to the compiled module). On each render Claude pipes its `StatusLineCommandInput` JSON to that script, which writes it to `<DUMP_DIR>/statusline/<spawnToken>.json`. The session polls/watches that file (`statusline.service.ts`), de-dupes byte-identical payloads, then `absorbDumpedPayload` extracts model/context/cost/rate-limits (→ `session_metadata`) and feeds the user's real statusline command (→ `statusLine` event). These payloads are written even in production (the backend depends on them); the `.raw` captures in the same dir are the only dev-only/debug part. The payload file is deleted on session stop.
- **Model authority** (runtime-authoritative, **transcript-only**): the stored model alias is reconciled to the *real* running model from the **transcript** — `handleModelChange` (the model id observed in the JSONL) calls `reconcileModelAlias` (`common/model.ts`) to correct `Session.currentModel` on a **family** mismatch (e.g. alias `sonnet` while running Opus, from an out-of-band `/model` or a wrong resume default). The statusline is deliberately **not** a source here (it's a render target, and only flows when a statusline command is configured); the model id lacks the 1M marker, so a same-family alias incl. `opus[1m]` is preserved and only a true family mismatch is corrected. `opusplan`/`haiku`-in-plan are preserved (valid alias≠sub-model). A model/effort pick made in the controller is held as **pending** on the backend (`set_pending_model` → `pendingModel`/`pendingEffort`, surfaced as `SessionInfo.modelPending`) until the next message applies it via respawn. The frontend trusts the backend's `SessionInfo` (no local model/effort clobber); localStorage is only a resume-config fallback. (`displayedModelLabel` still *renders* the statusline `display_name` for the badge text — that's display, not state.)
- **Effort authority** (runtime-authoritative, **transcript-only**): mirrors model authority. Claude Code records the *resolved* effort on every assistant JSONL entry (since v2.1.212), so `handleEffortChange` corrects `Session.currentEffort` after an out-of-band `/effort` — previously effort was write-only (set via `CLAUDE_CODE_EFFORT_LEVEL` at spawn, never read back) and the badge silently drifted. Same guards as the model path (no-op while respawning or a pending pick is unapplied). **`auto` is preserved, never corrected**: it means "use the model default", so a concrete observed level is `auto`'s *resolution*, not a mismatch — the same reason `reconcileModelAlias` preserves `opusplan`. Levels Claude Code accepts but we don't model (e.g. `ultracode`) are ignored rather than coerced (`isEffortLevel` in `common/types`).
- Input flows in reverse: phone taps Send → `{type:"input"}` → PTY stdin. Text is wrapped in bracketed-paste (`\x1b[200~…\x1b[201~`) and the submit `\r` is sent separately and **confirmed** against the transcript (resent if the prompt doesn't register) — see `Session.sendInput`/`submitWithConfirmation`, because a trailing `\r` coalesced into a large paste gets stripped. Approvals flow via `{type:"approval_response"}` → `hooks.service.resolveApproval()` which unblocks the pending `PermissionRequest` HTTP response.
- The frontend (`SessionView`/`QueuePanel`) **queues inputs locally** while Claude is busy and dispatches them in order — there is no optimistic echo; the queue is the source of truth for pending prompts.

### AskUserQuestion relay

Claude Code's `AskUserQuestion` is an interactive ink picker, not structured input — so the controller renders it as a `QuestionCard` and drives the CLI's picker over the PTY with **timed keystrokes** (the one place we synthesize navigation rather than relay structured data).

- `QuestionCard` (frontend) renders the questions/options/preview from the tool-call input, collects the answer locally, and sends `{type:"question_response", questions, answers, cancel?}` over WS. `questions`/`answers` are positional; shared shapes (`QuestionSchema`, `AnswerEntry`) live in `common`.
- `question.input.ts` `buildKeystrokes(...)` is a **pure** function translating an answer into a `KeystrokeChunk[]` script (each chunk = bytes + optional `settleMs`). Navigation rules were reverse-engineered from `claude-code-source/` and verified against PTY captures: single-select commits with `Enter` (auto-advances in a batch); multi-select toggles with `Space`; a preview-question note is `n` → type → `Esc` (NOT Enter) → select; a batched call ends on a review screen confirmed with one `Enter`.
- `Session.answerQuestion(chunks, confirm, toolUseId)` paces the writes (`CHUNK_DELAY_MS`, honoring per-chunk `settleMs`), then confirms the answer landed via the bus `tool_result` for that `toolUseId`, resending `Enter` if a multi-select submit raced ink's focus flush. If it never confirms (or the script is empty / dispatch throws), `Session.failQuestion` pushes a synthetic error `tool_result` so the card unlocks instead of stranding the UI.
- The reducer in `MessageStream.tsx` keeps a `results` map so a `tool_result` fuses onto its card regardless of arrival order (live vs. history pagination), and dedupes the eager `approval_request` card against the real `tool_call` (the `pr:` → `toolu_` promotion).

### Plan-mode relay

`ExitPlanMode` is an ink picker (`behavior:'ask'`) driven over the PTY like AskUserQuestion — the decision can't be relayed structurally, only by synthesizing keystrokes. Its hook story is subtle and was reverse-engineered live:

- **Signals.** ExitPlanMode fires a **`PreToolUse`** hook (registered scoped to `ExitPlanMode` in `hooks-config.ts`) *before* the picker, carrying the plan **inline** (`tool_input.plan`) and the real `tool_use_id`. `handlePreToolUse` pushes a `tool_call` from it (returning `{}` so the picker still opens) — this is what surfaces the `PlanCard` *in time*. (The transcript's own `tool_use` is written only *after* the picker resolves — too late — and the SessionBus dedups it by id.) ExitPlanMode **also** fires a `PermissionRequest`, but it's **notification-only** (responding allow/deny does NOT resolve the plan — verified live), so `handlePermissionRequest` **ignores ExitPlanMode** to avoid a duplicate card + a stranded hold.
- **Resolution = keystrokes (the picker is the only resolver).** `PlanCard` (frontend) renders the plan markdown + buttons and sends `{type:"plan_response", decision, feedback?, cancel?}`; the chat input stays **visible** (unlike AskUserQuestion). `plan.input.ts` `buildPlanKeystrokes(...)` drives the picker by **number key** (verify against PTY captures): `1` = approve + auto-accept edits, `2` = approve + manual; `keep-planning` with feedback = `3` → type → Shift+Tab (`\x1b[Z`), and without feedback / on `cancel` = `Esc`.
- `Session.answerPlan(chunks, confirm, toolUseId, resultingMode?)` confirms via the `tool_result` for that id — but does **not** resend `Enter` (the digit commit is atomic; a stray `\r` would commit the default-focused option). On a confirmed approval it `notePermissionMode(resultingMode)` (`accept-edits→acceptEdits`, `manual→default`) so the top-bar mode reflects the plan-exit mode immediately instead of waiting for the lagging JSONL `permission-mode` entry. `Session.failPlan` pushes a synthetic error `tool_result` to unlock the card on failure. `MessageStream` renders `ExitPlanMode` as a `PlanCard`, excludes it from tool grouping, and treats a resultless one as "waiting on the user" (no thinking spinner).

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

## Claude Code Version Alignment

We drive a CLI we neither ship nor pin, and everything fragile here — the AskUserQuestion and ExitPlanMode keystroke scripts, JSONL entry shapes, hook payload contracts — was reverse-engineered against one specific build. Drift fails *silently*: a picker gains an option and a digit keystroke selects the wrong one; a JSONL field is renamed and the watcher goes quiet.

- **One canonical number.** `CLAUDE_CODE_TARGET_VERSION` in `packages/common/src/version.ts` is the build we're verified against. Bump it only after re-verifying the relays against the newer CLI. Don't scatter "verified against vX" into comments — point at the constant instead. *Behavioral minimums* are different and stay inline (e.g. "since v2.1.126 the JSONL isn't pre-created") — those are facts about when a behavior appeared, not claims about what we tested.
- **The runtime version comes from the transcript**, not the statusline. Claude Code stamps `version` on every `user`/`assistant`/`system`/`attachment` JSONL entry; `TranscriptWatcher` reports changes via `onCliVersion` → `Session.handleCliVersion`, which warns on mismatch and surfaces `cliVersion` + `cliVersionStatus` on `SessionInfo`. The statusline payload carries a version too, but `absorbDumpedPayload` only runs when the user has a statusline command configured — so it isn't a dependable source. A mismatch is **never fatal**; most releases change nothing we touch.
- **Which binary runs is an environment decision.** The PTY spawns bare `claude` off PATH by default, so a machine with two installs resolves by PATH order. Pin `CLAUDE_BIN` (absolute path) in `packages/backend/.env` when that's ambiguous. The launch command is logged at spawn; the version that actually ran is reported separately from the transcript.
- **`CLAUDE_CODE_MINIMUM_VERSION` is a hard floor, not drift.** The AskUserQuestion relay depends on two upstream fixes — v2.1.144 (Esc in the preview-notes field returns to option selection instead of aborting the turn) and v2.1.181 (multi-select stopped dropping a typed "Other" answer). Below either, the relay produces a *wrong answer* rather than failing, so it logs at **error**, not warn. Never lower it without re-verifying both paths against live PTY captures.
- **Project-dir encoding.** `encodedProjectDir` must replace **every non-alphanumeric** character with `-`, not just path separators — a path with a space or bracket otherwise derives a directory that doesn't exist and the session streams nothing at all. `resolveTranscriptPath` falls back to a session-id scan for the cases we can't verify (>200-char paths, non-ASCII segments) and honors `CLAUDE_CODE_PROJECT_DIR_NAME`.

## Reference: Claude Code Source

`claude-code-source/` contains a snapshot of the Claude Code CLI source for reference — used to understand hook payloads, JSONL entry shape, and the `--settings` inline JSON handling. Key files:

- `src/main.tsx:432-483` — `--settings` inline JSON parsing
- `src/utils/hooks/execHttpHook.ts` — HTTP hook POST contract
- `src/entrypoints/sdk/coreSchemas.ts:380-580` — all hook event payload schemas
- `src/schemas/hooks.ts` — settings.json hook config shape (zod)

Gitignored, not part of the build.

**It is frozen at v2.1.87 (`CLAUDE_CODE_REFERENCE_SNAPSHOT_VERSION`) and cannot be updated.** That tree exists only because a one-time source-map exposure briefly made the unbundled TypeScript downloadable (see its README); there is no newer unbundled source to re-vendor, and the shipped CLI is a compiled Bun binary whose embedded strings are compressed and not greppable. Treat it as a **hint about intent, never as ground truth for current behavior** — that has to come from live PTY captures (`dump/captures/*.raw`) against the build actually running. Expect it to drift further from `CLAUDE_CODE_TARGET_VERSION` over time.
