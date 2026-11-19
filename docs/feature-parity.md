# Claude Code feature parity

## Purpose and baseline

Claude Code parity is the product roadmap. The goal is to operate a local Claude Code session from the phone without having to return to its terminal to discover a feature, answer a dialog, or understand its state. Match user outcomes, not terminal pixels or every keybinding.

Inventory date: **2026-11-16**. Application baseline: **91ce970**. Installed CLI checked with `claude --version`: **2.1.325**. Last full relay verification target: **2.1.322**; shell-job evidence was collected on **2.1.323**. Installation, documentation and verification are different version facts. This inventory does not certify 2.1.325 compatibility or bump the verified target.

Official documentation is rolling and can describe features gated by version, account, provider or platform. Sources below establish upstream capabilities, not proof that every capability is enabled on this machine. Some long pages were read only in the relevant opening sections; this is a feature-family inventory, not a claim to have exhaustively tested every slash command.

For the command-by-command assessment, aliases, argument forms and rollout order,
see [Slash-command coverage plan](slash-command-plan.md). That plan separates
current dispatch from feasible future support; it does not enable commands.

## Status rules

- **Native:** A dedicated Controller flow exists. Its stated limits still apply; this is not a claim that every edge case has been tested.
- **Partial:** Some of the workflow is represented, but meaningful controls, information or recovery are missing.
- **Inherited:** Claude Code may use the installed feature, but the Controller does not expose its discovery, configuration or lifecycle. This is not native parity.
- **Missing:** No dedicated implementation was found in the current protocol, routes and relevant services.
- **Excluded:** Explicit product decision or a current architectural constraint. Revisit only by discussion.

A command string reaching the CLI is not evidence that its picker, confirmation or result is usable on the phone. Asking Claude to perform an action is useful, but does not count as a deterministic app control. A general-purpose terminal is not a substitute for structured Claude-session controls.

## Inventory

Each item has a stable ID for follow-up work. Checked items mean the narrow native workflow exists, not that its whole category is complete.

### Conversation and sessions

- [x] **S01 — Native: create, select and resume local sessions.** Multiple sessions, per-project recent conversations and a stopped-session Resume flow exist. Local JSONL survives backend restarts; live PTYs and the in-memory registry do not. **Partial: explicit session termination.** `stop_session` exists in the protocol and hook, but no visible control calls it; the composer's Stop interrupts the current turn, not the session. Evidence: `packages/backend/src/services/session-manager.service.ts`, `packages/frontend/src/hooks/use-sessions.ts`, `packages/frontend/src/views/SessionView.tsx`, `InputBar.tsx`.
- [x] **S02 — Native: text input, interrupt, local queue and Send now.** Pending queues survive navigation between chats within the loaded app; that is not durable offline storage. Recall is the last applicable prompt, not the CLI's full input-history search. Evidence: `InputBar.tsx`, `QueuePanel.tsx`, `SessionView.tsx` under `packages/frontend/src`.
- [ ] **S03 — Partial: history and search.** Project-session listing has search and pagination; chat renders retained events and fetches older retained pages. There is no dedicated full conversation/tool-result search, export/download flow, or transcript-wide search across evicted history. Evidence: `useProjectSessions` in `hooks/use-sessions.ts`, `MessageStream.tsx`, `session-bus.service.ts`.
- [ ] **S04 — Partial: naming and organization.** Session creation accepts a name; recent-chat labels read the CLI's saved custom title, and tags exist in app types. No dedicated rename/tag/archive/delete/export controls were found. Fields or raw `/rename` forwarding do not establish native management parity. Evidence: `SessionConfig`/`SessionInfo` in `packages/common/src/types/index.ts`, `SessionTopBar.tsx`, `packages/backend/src/utils/project-sessions.ts`, `session.ts`.
- [ ] **S05 — Missing: native conversation branch/fork and checkpoint rewind.** No app flow for choosing a checkpoint, restoring code versus conversation, or targeted summarization. No first-class `/branch`/`--fork-session` lifecycle. Rewind is not Git reset, and Git diff is not checkpoint history. Evidence: current `ClientMessage` union and session routes. Upstream: [Sessions](https://code.claude.com/docs/en/sessions), [Checkpointing](https://code.claude.com/docs/en/checkpointing).
- [ ] **S06 — Partial / verify first: session-changing commands.** `/clear`, `/resume`, `/branch` and background-session handoff can change which conversation/process is active. Raw command dispatch exists, but no general rebinding protocol was found for controller session ID, transcript, hook routing and queue ownership after such a transition. This is a compatibility risk to probe, not a reproduced failure. Evidence: `Session.sendSlashCommand`, backend `ws.service.ts` slash handler, frontend `use-sessions.ts`; upstream [Commands](https://code.claude.com/docs/en/commands).

### Input, commands and configuration discovery

- [ ] **I01 — Partial: command and skill discovery.** The composer offers docs-based suggestions and bounded user/project file discovery with support guidance. Loaded status, plugins, MCP, effective precedence and full argument completion remain unknown. See [Commands](commands.md).
- [ ] **I02 — Excluded for now by user decision: attachments.** Do not implement image/camera/paste uploads, file attachments or attachment transport in the current roadmap. File-path navigation and optional text/path completion remain separate candidates; they must not silently become uploads. The composer currently carries text only. Evidence: `ClientMessage.input`, `InputBar.tsx`, `TranscriptWatcher.handleUser`. Upstream: [Interactive mode](https://code.claude.com/docs/en/interactive-mode).
- [ ] **I03 — Partial: local-command results and interactive dialogs.** Text recorded as local-command output can render in chat. Dedicated relays exist for questions and plan approval, not arbitrary `/config`, `/mcp`, `/permissions`, `/copy`, `/rewind` or other terminal dialogs. Availability and argument-based alternatives must be catalogued per installed version, not assumed. Evidence: `TranscriptWatcher.flushPendingSlashCommand`, `QuestionCard`, `PlanCard`, shared response types.
- [ ] **I04 — Inherited: instructions, rules and memory.** The real CLI loads applicable configuration; project files can be inspected through Files. There is no effective-config view showing user/project/managed scope, precedence, what actually loaded, or an app memory editor. Reading a local config file alone cannot prove effective runtime state. Upstream: [Extension overview](https://code.claude.com/docs/en/features-overview), [Memory](https://code.claude.com/docs/en/memory).
- [ ] **I05 — Partial: skills, plugins and MCP tools.** A read-only MCP configuration inventory covers selected user, local and project files, without claiming effective or live status; see [Integrations](integrations.md). Existing installations can participate in a session and ordinary tool calls can render. Plugin inventory, live capabilities, install/enable/reload and MCP authorization/reconnection UI remain missing. Agent-definition browsing is also missing. Upstream: [Extension overview](https://code.claude.com/docs/en/features-overview), [Plugin overview](https://code.claude.com/docs/en/plugins/overview), [MCP](https://code.claude.com/docs/en/mcp).
- [ ] **I06 — Missing: voice, rich input history and side-question presentation.** No dictation control or dedicated `/btw` side conversation. Voice/transcript/terminal keybindings should be translated into mobile outcomes where useful, not reproduced literally.

### Permissions, questions and planning

- [x] **P01 — Native: one-call approve/deny and input editing.** Cards show validation rejection and expiry; the hook fails closed. This does not include every option from the CLI's permission prompt. Evidence: `ApprovalCard.tsx`, `approval-response.ts`, `hooks.service.ts`, `verify:approval-edit`.
- [ ] **P02 — Partial: permission configuration and scope.** Four modes and verified-alias switching exist. No native persistent allow/ask/deny rule editor, approval-for-session/rule selection, additional-directory manager or sandbox-settings UI. Unverified model cycles are intentionally refused. `dontAsk` and `bypassPermissions` are not represented as app modes. Do not weaken this guard to make the checklist look complete. Upstream: [Permissions](https://code.claude.com/docs/en/permissions).
- [ ] **P03 — Partial: questions and plan approval.** Native structured question cards, multi-select/custom answers, plan preview and short planless approval exist. They use verified keystroke relays, not a generic terminal-dialog API. The current plan card/protocol has no feedback field, Ultraplan or clear-context controls. **Known mapping risk:** `plan.input.ts` documents that a high-context clear-context option can shift the numbered choices, making the normal-context approval mapping choose the wrong action. That is a P0 safety gap, not full plan parity. Editing-mode differences also require live verification. Do not infer broader coverage from old prose about feedback in `CLAUDE.md`. Evidence: `PlanCard.tsx`, `QuestionCard.tsx`, `packages/backend/src/services/plan.input.ts`, shared `plan_response` and `scripts/verify/README.md`.
- [ ] **P04 — Partial: attention state across all sessions.** The active chat shows approvals, questions, failures and stopped state. No comprehensive cross-session attention inbox or native push delivery. Push notifications belong to this gap rather than an unrelated feature initiative.

### Models, context and usage

- [x] **M01 — Native with limits: model and effort picks.** Runtime model labels and learned aliases exist; a pending pick applies on the next message through respawn. Permission-mode switching is restricted to verified aliases. Unknown models currently receive all effort options without capability verification; see M02. Evidence: `common/model.ts`, `model-catalog.service.ts`, session settings components.
- [ ] **M02 — Partial: capability and advanced model controls.** Known-family effort gating is still coded and needs re-verification as families evolve; learning a model name does not establish accepted effort tiers. No native fast-mode, advisor or ultracode/workflow controls and associated availability/state presentation. Evidence: `model-config.ts`, `EffortLevel`, `SessionStatusSnapshot`. Upstream: [Commands](https://code.claude.com/docs/en/commands).
- [ ] **M03 — Partial: context, usage and compaction.** Context percentage, token/cost totals, rate-limit windows, custom statusline and compaction summaries exist. Missing detailed context attribution, cache hit/miss reasoning, spend-limit UI, auto/idle-compaction controls and targeted summaries. Existing cache fields in payload types do not mean the UI exposes them. Evidence: `SessionStatusSnapshot`, `statusline.service.ts`, `SessionTopBar.tsx`, `MessageStream.tsx`.
- [ ] **M04 — Inherited / unverified: prompt-cache and idle-compaction behavior.** The CLI owns caching; the Controller must not implement its own model request/cache layer. Idle-compaction probe did not trigger, so its hook contract is unresolved. Cache impact of model/effort changes is model/provider/version dependent; Max-plan usage is still a real resource. Upstream: [Prompt caching](https://code.claude.com/docs/en/prompt-caching).

### Agents, tasks and automation

- [x] **A01 — Native read-only: runtime agents.** Tree, status, per-agent history and agent-message feed exist, with backfill. Generic Agent tool output alone would not qualify. Evidence: `agent-registry.service.ts`, `AgentsSheet.tsx`, `use-agents.ts`.
- [ ] **A02 — Partial: agent lifecycle/control.** No native start-by-definition, pause/stop/foreground controls or worktree/role configuration. Historical liveness cannot always be proven; team teardown need not supply the same signal as explicit shutdown. Native cross-session messaging remains missing. Read-only workflow observation is covered separately by A07. Upstream: [Agents](https://code.claude.com/docs/en/agents).
- [ ] **A03 — Excluded by user decision: direct phone chat with an individual agent.** Do not reopen this implementation merely to increase coverage. Observing agent-to-agent messages remains supported.
- [ ] **A04 — Partial: Claude background shell jobs.** Read-only Bash job identity, status and bounded output exist. Direct stop/input/foreground controls are not verified; PowerShell, monitor tasks and subagent-owned jobs are not claimed supported. A job absent from the view is not proof no job is running. Evidence: `shell-jobs.service.ts`, [Shell jobs](shell-jobs.md).
- [ ] **A05 — Missing: unified task checklist, schedules and goals.** TaskCreate/TaskUpdate-style calls may appear as ordinary tool cards, but there is no task-state dashboard, `/loop`/cron manager or `/goal` lifecycle UI. Scheduled work and active goals need an idle-reaper policy before promising reliable unattended execution. Upstream: [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks), [Goal](https://code.claude.com/docs/en/goal).
- [ ] **A06 — Inherited / unverified: channels and extension automation.** User hooks or configured external integrations may execute inside the CLI. No app setup/status/consent surface for channels, browser/computer tools or mod-rendered panes. Platform/account capability must be discovered rather than inferred from docs alone.

- [x] **A07 — Native read-only: workflow observation.** The Workflows entry shows runs, declared/observed phases, completed/observed agent counts, per-agent model/context and available transcript links. Current-process hooks establish live agent status; replay does not. No launch, pause, stop or restart controls. Structured-data and browser-verification limits are recorded in [Workflow observation](workflows.md). Evidence: `workflow-registry.service.ts`, `use-workflows.ts`, `WorkflowsPanel.tsx`.

### Workspace and shell workflows

- [x] **W01 — Native read-only: Files and Git Changes.** Cwd-rooted file viewing, source lines/highlighting, staged/unstaged/untracked changes and responsive diffs exist. Workspace-wide changes are not attributed to a particular Claude turn. Binary/large-file/path restrictions are explicit. Evidence: [Workspace](workspace.md), workspace services and `WorkspacePanel.tsx`.
- [ ] **W02 — Missing: file-to-chat and edit-review integration.** No dedicated click-through from every tool path to the viewer, selection-to-prompt/line mentions, inline Edit/Write diff cards, file editing, staging/reverting/commit/PR UI or live dev-preview/port routing. A shell or a prompt can perform some actions, but that is not a native review workflow.
- [x] **W03 — Native with platform limits: independent user terminal.** Separate PTY, explicit creation/control, reconnect, close/remove and bounded output. It is not Claude's shell-job input, not globally shared between sessions and not filesystem-sandboxed. Windows was exercised; Linux cleanup was probed but full Linux UI path remains unverified; macOS/BSD fail closed. Evidence: [Interactive terminal](interactive-terminal.md).
- [ ] **W04 — Partial / verify first: current directory and worktrees.** Files/Changes and new terminal cwd derive from the Controller's known session config. No dedicated EnterWorktree/ExitWorktree or `/cd` reconciliation updates that config as a first-class workflow. Additional-directory access is also not mirrored into the file browser. Probe whether runtime cwd differs after those operations before claiming the panel follows Claude's actual working tree. Upstream: [Worktrees](https://code.claude.com/docs/en/worktrees), [Commands](https://code.claude.com/docs/en/commands).

### Remote operation and platform surface

- [x] **R01 — Native: phone connection and recovery.** Tailscale/Caddy transport, reconnect/re-subscribe, request errors, idle cleanup and responsive app views exist. A phone connection does not keep the machine awake or the backend running as a service. Evidence: backend `server.ts`, frontend `ws.service.ts`, lifecycle services.
- [ ] **R02 — Missing: attention notifications.** No app push subscription/permission/service-worker delivery flow. Existing local Claude notification hooks are not phone push. Event correctness, opt-in/privacy/mute rules and persistent subscription/key storage need design before implementation.
- [ ] **R03 — Missing: app-side platform/cloud integrations.** No first-class cloud teleport, daemon/background-session attachment, artifacts browser/publishing, IDE/browser/computer-use integration UI or provider/account setup. These should not all be flattened into one local-CLI milestone. Some are separate services/products with account restrictions.

## Priority order

No percentage score: a working command with an invisible confirmation is not half a safe workflow. Rank gaps by whether they block everyday Claude Code use, cause wrong state, or leave the user needing the local terminal.

### P0 — Safe command coverage and runtime identity

- [ ] **PAR-01 — Partial: command/capability matrix.** A docs-based classified seed, user/project skill discovery and a composer picker now exist ([Commands](commands.md)). Known session/cwd transitions and unrepresented dialogs are guarded rather than silently forwarded. Runtime availability, plugin/MCP inventory and argument-sensitive completeness remain unverified. Do not treat the static seed as account-specific capability or product PTY-output parsing as an acceptable discovery source.
- [ ] **PAR-02 — Probe identity/cwd transitions.** Exercise `/clear`, explicit `/resume`, `/branch`, worktree enter/exit and `/cd` in disposable sessions. Record session/transcript IDs, hooks, cwd and required launch configuration. Acceptance: either the Controller safely follows the transition or gives an explicit unsupported path before input can be misrouted. No silent global directory broadening.
- [ ] **PAR-03 — Surface unrepresented interactive states.** Inventory trust/setup, permissions, MCP auth, resume usage warnings and command dialogs. Address the documented high-context plan-option mapping risk before claiming plan parity; distinguish variants reliably or refuse ambiguous actions rather than guessing. Implement safe native equivalents or clear guidance only after observing the relevant contract. A permanently waiting session with no actionable phone state is a parity blocker.

### P1 — Everyday input and setup

- [ ] **PAR-04 — Partial: commands/skills picker plus effective setup inspection.** Picker source/scope/support labels and scalar argument hints are implemented. Installed versus loaded/effective state, plugin/MCP catalogs and instruction-source inspection remain. Editing configuration and OAuth/secret handling require an additional security design.
- [ ] **PAR-05 — File navigation/context conveniences only.** Tool-path links and optional text/path completion remain candidates. **Attachments are excluded for now by user decision:** no image/camera/file upload or automatic content attachment. Keep host paths confined; never interpret a typed local path as permission to upload arbitrary files.
- [ ] **PAR-06 — Permission completeness.** Scoped persistent rules and additional directories, plus model-capability verification. Preserve managed-policy precedence and show exactly what a stored rule authorizes.

### P2 — Recovery and unattended work

- [ ] **PAR-07 — Checkpoints, branches and complete history.** Native rewind with code/conversation scope, fork/branch ownership, search and export. Preserve original history and make destructive restore explicit. Do not replace checkpoint semantics with Git reset.
- [ ] **PAR-08 — Unified task/workflow state.** Read-only workflow phases/agents are implemented (A07); task checklists, scheduled tasks/goals and workflow controls remain. Prove liveness and cleanup across resume; never idle-stop work merely because it is awaiting a scheduled wakeup.
- [ ] **PAR-09 — Attention routing and push.** A cross-session needs-input/error/done inbox first, then opt-in push of those same verified events. Notifications should deep-link to the correct session and be private by default. Persistent push state must be reconciled with the current in-memory/no-database architecture; do not silently add storage or a new transport/auth system.

### P3 — Remaining platform-dependent gaps

- [ ] **PAR-10 — Worktree/Git action UI, artifact/dev previews and broader platform support.** Plan each independently, after command/cwd foundations. Publish/account integrations and durable automation are discussions, not assumed implementation authorization.

**Recommended next implementation:** PAR-02 transition probes and argument-specific command verification, followed by plugin/MCP and effective-config inspection. The initial PAR-01/PAR-04 picker has landed, but its explicit discovery limits remain; do not lift transition guards without evidence. Push notifications remain useful, but do not replace this foundation.

## Definition of done for a parity item

- A person can discover it, invoke it, observe progress/result, answer required prompts and recover from failure on the phone.
- Native versus inherited/unsupported behavior is explicit, including platform/account constraints.
- Session ID, cwd, permissions, input ownership and model authority stay correct across reconnect, resume and relevant transitions.
- Use hooks, transcripts and supported CLI contracts; no direct Anthropic API/Agent SDK and no product PTY-output parsing under this project's contract.
- Record source + installed CLI + actually verified build separately. Re-run the relevant probes on upgrades; don't infer capability from model-name parsing alone.
- Run the PR-review workflow for each change and patch concrete findings. Security review is required for file/command execution, credential, permission, plugin/MCP, upload, notification or trust-boundary changes.
- Exercise phone, tablet, desktop and error states. Do not label a typecheck or synthetic fixture as a live end-to-end check. Keep the user's rule against adding tests unless requested.
- Commit incrementally and update this checklist when a capability lands or its evidence changes.

## Source map and coverage limits

Local anchors above are relative to the repo; component filenames without a full path live under `packages/frontend/src/components/`, and backend service names live under `packages/backend/src/services/` unless indicated otherwise (`Session` is `packages/backend/src/session/session.ts`). The shared protocol is `packages/common/src/types/index.ts`; absence claims were checked against it, the routes and the relevant feature components/services. CLI-owned behavior may still work via ordinary chat or the terminal without a native app affordance.

Official references consulted on the inventory date:

- [Overview](https://code.claude.com/docs/en/overview) and [documentation index](https://code.claude.com/docs/llms.txt) — feature-family discovery and surface distinctions.
- [Commands](https://code.claude.com/docs/en/commands) and [Interactive mode](https://code.claude.com/docs/en/interactive-mode) — command taxonomy, input, dialogs, background Bash and mobile-relevant outcomes.
- [Sessions](https://code.claude.com/docs/en/sessions), [Checkpointing](https://code.claude.com/docs/en/checkpointing), [Worktrees](https://code.claude.com/docs/en/worktrees) — identity, restore and directory transitions.
- [Extension overview](https://code.claude.com/docs/en/features-overview) — instructions, skills, agents, workflows, MCP, hooks and plugins.
- [Permissions](https://code.claude.com/docs/en/permissions), [Prompt caching](https://code.claude.com/docs/en/prompt-caching), [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks) — control and unattended-work constraints.

Linked family references not examined in depth, including platform/cloud/mod APIs, require focused research and installed-build checks before implementation. This document authorizes no feature merely by listing it.
