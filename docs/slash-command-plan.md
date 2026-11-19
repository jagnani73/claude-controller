# Slash-command coverage and implementation plan

## Decision and baseline

The command picker is incomplete. Do not add another batch of names and call that parity: plan and verify **command forms**, including arguments, aliases, side effects, interaction requirements and result visibility.

This is a plan, not an implementation or an authorization to run every command. The catalog-warning/large-skill fix is paused. No dispatch policy was changed while producing this document.

- Checked on **2026-11-19** against app **ef9dfe3** and installed Claude Code **2.1.328**.
- The full rolling [command reference](https://code.claude.com/docs/en/commands.md) was read, including aliases and removed entries. It is broader than the commands enabled on a particular account/platform. The installed CLI's actual menu has **not** been exhaustively inventoried or tested.
- Last full relay verification remains **2.1.322**. The [2.1.328 transition probe](session-transition-probe.md) was inconclusive because an auto-mode setup dialog intercepted input.
- Read [current discovery limits](commands.md) and the wider [feature-parity roadmap](feature-parity.md) alongside this plan. Attachments and direct phone chat with individual agents remain excluded by the user's decisions.

## What is wrong with the current list

The app has two static name lists in `packages/common/src/commands.ts`: transitions and dialogs. Those lists block **every** argument form of their names. Only explicit model/effort forms are treated specially; `/compact` and `/context` have forwarded suggestions. Every other syntactically accepted slash name falls through as **unverified forwarding**, whether or not it appears in the picker.

Consequently:

- **Missing from the menu does not mean blocked.** `/continue`, `/undo`, `/bashes`, `/restart`, `/update`, `/stop`, `/workflows`, `/skills` and `/heapdump` are examples that can currently fall through while equivalent or related names are guarded.
- **Blocked does not mean impossible.** `/rename <name>`, `/export <filename>`, `/mcp reconnect <server>` and `/config key=value` have documented argument-based forms. They need different plans from their bare picker forms.
- **Some labels are wrong for the current CLI.** `/agents` is documented as a text reminder on newer builds, `/doctor` is now a bundled skill, and `/vim` is documented as removed. Grouping all three as generic dialogs loses meaningful distinctions.
- **The menu is not an installed-availability API.** Docs suggestions, discovered local files, installed plugins, effective visibility and loaded runtime commands are distinct facts. Account/feature flags and managed settings can hide or change commands.
- **Discovery has known omissions.** It reads direct user/project skills and supported plugin cache layouts, not all ancestors, nested namespaces, synced skills or live MCP prompts. Files over the current 16 KiB whole-file limit are skipped; inspecting file sizes found six user skills above that limit. This does not prove the total missing-command count.

A safer catalog must tell the user what will happen, not display a long warning paragraph followed by Retry for a nontransient limitation.

## Reading this inventory

**Current behaviour:**

- **App:** Intercepted by the Controller rather than sent directly. This does not prove exact parity with the CLI's persistence or timing semantics.
- **Blocked:** The current name-based guard rejects it, including argument forms.
- **Forwarded:** Eligible for unverified raw dispatch, including names absent from the suggestions. The composer warning is shown for drafts beginning with `/`; leading whitespace is trimmed for dispatch but currently bypasses that raw-prefix warning. It does not mean tested or safe end to end.

**Proposed integration paths:**

- **Relay candidate:** Potentially forward an explicit form, after observing structured input/result/side-effect signals. No terminal-output parsing in product code.
- **Native action:** Perform the equivalent through app controls, or present the result using app state. Be explicit if only part of the CLI outcome is available.
- **Dedicated integration:** Needs new state/lifecycle, a confirmation or authentication flow, or a structured UI; do not disguise it as a simple relay.
- **Local-only for now:** No justified phone-side implementation yet, or the action is risky, platform-specific or not useful to mirror.
- **Removed:** Do not offer as an available built-in; provide a migration hint if typed.

These are feasibility decisions, not live-test results. Nothing below upgrades a command to verified support.

## Command-by-command coverage

### 1. Settings, context and ordinary session metadata

- **`/model <model>`; bare `/model`.** Current: explicit valid-shape argument is App; bare is Blocked. Proposed: native picker for bare form, preserve explicit selection. The current implementation applies clamped pending settings to active sessions and attempts to persist the global default asynchronously; invalid configuration or I/O failure can prevent that write. Verify this intentionally matches the chosen scope. The CLI also offers a session-only selection inside its picker. Do not invent model capabilities from aliases.
- **`/effort <level|auto>`; `/effort status`; `/effort ultracode [on|off]`; bare `/effort`.** Current: listed levels/auto are App; status, ultracode and bare are Blocked. Proposed: native effort control; a read-only status action is a small extension, but label configured versus observed effort. Ultracode needs workflow/capability configuration and reconciliation. Docs say `max` is session-only while the app currently treats the intercepted effort command as a global preference update: resolve that mismatch before claiming parity.
- **`/compact [instructions]`.** Current: Forwarded. Proposed: relay candidate, with one summary, real completion/failure and queue behaviour verified. Instructions must arrive intact. Do not assume the summary banner alone proves completion or that compaction preserves every pending operation.
- **`/context [all]`.** Current: Forwarded. Proposed: verify whether useful structured/transcript output is recorded; otherwise native context inspector. The current context percentage is not the CLI's full attribution grid.
- **`/recap`.** Current: Forwarded, not suggested. Proposed: relay candidate if its generated summary is visible without a hidden interaction; measure usage and whether it enters conversation history.
- **`/rename [name]`; `/tag` (precautionary current guard).** Current: Blocked. `/rename` is documented; `/tag` is not an entry in the retrieved reference. Proposed: explicit rename is a relay/native candidate with immediate sidebar/top-bar synchronization and sanitization; bare auto-generated rename has generation/usage semantics to preserve. Keep `/tag` unverified rather than fabricate current support from the existing guard.
- **`/color [color|default]`.** Current: Forwarded, not suggested. Proposed: native session accent or explicitly terminal-only; never show success if only the unseen CLI prompt bar changes. Bare form chooses a random color, not a picker according to the reference.
- **`/output-style [style]`.** Current: Blocked. Proposed: explicit style is a relay candidate with persistence/runtime confirmation; bare style listing needs observation before choosing text result versus native picker.
- **`/advisor [model|off]`.** Current: Blocked. Proposed: explicit form is a relay candidate with capability, cost and current-state visibility; bare form is a picker in our interactive PTY, even if other surfaces print text.
- **`/autocompact [auto|tokens]`.** Current: Blocked. Proposed: explicit configuration control with model/provider validation, scope disclosure and recovery; bare dialog becomes a native settings view. Do not automatically change the user's idle-compaction choice.
- **`/fast [on|off]`.** Current: Blocked. Proposed: dedicated/native control after plan/model availability and billing implications are understood; explicit on/off is preferable to an ambiguous toggle. Never silently enable extra spend.
- **`/config [key=value ...]`; alias `/settings`; `/config --help`.** Current: all Blocked. Proposed: separate a native settings picker, read-only accepted-key discovery, and a deliberately allowlisted set of explicit settings. Some keys need confirmation and must not bypass it. A generic config write can alter permissions, hooks, network and secrets; it is not a low-risk text relay.

### 2. Existing app views and read-only reporting

- **`/diff`.** Current: Blocked. Proposed: open Workspace → Changes. Clearly label this as the app's read-only working-tree diff, not the full CLI review interface or its mutation controls.
- **`/workflows`.** Current: Forwarded, not suggested. Proposed: open Workflows. Our view is read-only; CLI pause/resume/save controls remain a dedicated integration, not an implied capability of the shortcut.
- **`/tasks`; alias `/bashes`.** Current: `/tasks` Blocked; `/bashes` Forwarded. Proposed: native task overview combining agent/workflow/shell views, with partial-coverage notice until every task kind is represented. Direct task controls require verified semantics. Close the alias inconsistency first.
- **`/skills`; `/skill-doctor`.** Current: Forwarded, not suggested. Proposed: native skill inventory and usage inspection. The current catalog is not equivalent to the CLI's effective visibility editor, and does not know token cost or usage frequency.
- **`/agents`.** Current: Blocked. Proposed: verify its documented text reminder, or open a clearly named agent-definition/inventory view. Do not confuse definitions with the existing runtime-agent tree.
- **`/list-agents`; alias `/peers`.** Current: Forwarded, not suggested. Proposed: read-only peer-list relay/native candidate, gated by availability; do not expose direct individual-agent chat, which was excluded by the user.
- **`/help`.** Current: Blocked. Proposed: open the command browser with current support explanations, source labels and links to official help. Do not claim that a docs-derived list is the live CLI menu.
- **`/status`.** Current: Blocked. Proposed: native status panel covering supported runtime data and marking unknown account/connectivity facts. Inspect setup currently shows configuration, not live MCP health.
- **`/usage`; aliases `/cost`, `/stats`.** Current: usage/cost Blocked; stats Forwarded. Proposed: native usage panel with the subset available from structured sources; full account statistics and billing data need a supported source, not credentials or scraped screens.
- **`/hooks`.** Current: Blocked. Proposed: read-only effective hook configuration view first; hook editing/execution is separate, permission-sensitive work.
- **`/release-notes`.** Current: Forwarded, not suggested. Proposed: native versioned release-note viewer. Avoid opening its invisible terminal version picker.
- **`/copy [N]`.** Current: Blocked. Proposed: phone/browser Copy on the selected message/block, not the host clipboard. `N` should resolve against the complete appropriate history, or report that older content must be loaded. Block selection needs native UI.
- **`/export [filename]`.** Current: Blocked. Proposed: explicit export/download workflow with a clear choice of phone download versus host file. A filename form may avoid the CLI dialog but still writes files; confine paths and obtain appropriate confirmation. Bare form must not open a hidden clipboard/save menu.
- **`/insights`; `/team-onboarding`.** Current: Forwarded, not suggested. Proposed: relay-plus-report workflow with explicit history/privacy/usage scope and safe report opening. Generating HTML or a sharing link is not merely a free status read.

- **`/btw [question]`.** Current: Blocked. Proposed: dedicated side-question UI preserving its documented exclusion from conversation history; bare form's prior-answer browsing is a separate stateful view. Do not pretend an ordinary queued chat prompt has equivalent context semantics.

### 3. Conversation identity, working directory and lifecycle

These require the transition probe and controller ownership design. Existing guards must stay until we can distinguish a new conversation, a process handoff and a changed directory.

- **`/clear [name]`; aliases `/reset`, `/new`.** Current: Blocked. Proposed: native new conversation preserving the old one, or verified rebinding after the CLI transition. Capture session ID, transcript path, hook routing, queue, agents and optional previous-session naming.
- **`/resume [session]`; alias `/continue`.** Current: resume Blocked; continue Forwarded. Proposed: native session selector for stopped history; attaching an already-running background session is a different operation. Close the unguarded alias, then verify running-session handoff separately.
- **`/branch [name]`.** Current: Blocked. Proposed: native conversation branching with correct original/child identity, transcript ownership and history. Not equivalent to a Git branch.
- **`/fork [prompt]`; `/background [prompt]` and alias `/bg`.** Current: Blocked. Proposed: dedicated multi-process registry/attachment integration. These may detach the owned PTY or create a new background session; ordinary subagent rendering does not solve ownership.
- **`/stop`.** Current: Forwarded, not suggested. Proposed: dedicated explicit stop for the correct background session, with clear target and retained history. Do not map it casually to the composer's interrupt button.
- **`/exit`; alias `/quit`.** Current: Blocked. Proposed: explicit app stop/detach action, distinguishing normal and background sessions. Closing an app panel is not the same as killing the CLI.
- **`/cd <path>`.** Current: Blocked. Proposed: native directory-change workflow with validation and reconciliation of session cwd, transcript resolution, settings, files/diffs, agent/workflow paths and subsequent terminal creation. A successful shell `cd` is not the CLI `/cd` operation.
- **`/add-dir <path>`.** Current: Blocked. Proposed: scoped access grant with clear confirmation, tracked directories and security review. It grants file access, not necessarily configuration discovery. Do not silently expand the file browser's root.
- **`/worktree` (current precautionary guard).** Current: Blocked. No matching slash entry was present in the retrieved full reference; worktree tools/launch flags are separate. Inventory those surfaces explicitly; do not advertise `/worktree` as a verified command merely because our block list contains it.
- **`/rewind`; aliases `/checkpoint`, `/undo`.** Current: rewind/checkpoint Blocked; undo Forwarded. Proposed: native checkpoint picker with code versus conversation restore, summarization scope, confirmation and rollback semantics. Not Git reset. Close the alias gap before implementing.
- **`/restart`; alias `/update`.** Current: Forwarded, not suggested. Proposed: operator-controlled restart only after process ownership, installed binary and transcript recovery are verified. The reference gates this to native macOS/Linux, excluding WSL and Windows; do not offer it as available on this Windows host.
- **`/tui [classic|default|fullscreen]`.** Current: Forwarded, not suggested. No-argument status is a separate candidate from a renderer switch/relaunch. Keep renderer changes local-only until lifecycle effects are verified; the Controller's layout is independent.
- **`/desktop`; alias `/app`; `/teleport` and alias `/tp`.** Current: Blocked. Proposed: dedicated cross-surface/cloud handoff, or local-only for now. These are not regular resume commands.
- **`/remote-control`; alias `/rc`.** Current: Blocked. Proposed: local-only for now; the Controller already has a separate transport. Adding another attachment surface requires an explicit ownership/concurrency design.

### 4. Permissions, planning, authentication and integrations

- **`/plan [description]`.** Current: Blocked. Proposed: native Enter plan mode, then queue the optional task after the mode change is confirmed. Existing Shift+Tab mode controls and ExitPlanMode approval are foundations, not proof this command is fully represented. High-context approval option ambiguity remains a separately documented P0 risk.
- **`/permissions`; alias `/allowed-tools`.** Current: Blocked. Proposed: native scope-aware allow/ask/deny rules and directory permissions; preserve managed-policy precedence and make persistent grants explicit.
- **`/auto-mode-setup`.** Current: Forwarded, not suggested. Proposed: dedicated review/confirmation of generated environment rules. This setup dialog intercepted our last transition probe; it must never be treated as a harmless unrepresented skill.
- **`/sandbox`.** Current: Blocked. Proposed: native safety configuration only on supported hosts, otherwise local-only. Do not equate shell list scoping with filesystem/process sandboxing.
- **`/mcp`; `/mcp reconnect <server|all>`; `/mcp enable/disable ...`.** Current: all Blocked. Proposed: bare command opens Inspect setup with an explicit static-inventory label; real status/auth needs new integration. Explicit reconnect/enable/disable are documented noninteractive candidates, but verify authentication prompts, configuration persistence and confirmation before allowing them. Never call configured servers just to populate the menu.
- **`/plugin [list|install|enable|disable|...]`; current `/plugins` precaution.** Current: Blocked. Proposed: native inventory for list; exact mutation forms require a separate install/enable/security workflow because plugin activation executes code/hooks and may change MCP tools. `/plugins` was not an alias entry in the retrieved reference—keep it unverified, not invented.
- **`/reload-skills`.** Current: Forwarded, not suggested. Proposed: strong explicit relay candidate; confirm returned counts, refresh the app's discovered catalog and distinguish disk discovery from CLI-loaded state.
- **`/reload-plugins [--force]`.** Current: Forwarded, not suggested. Proposed: explicit relay/native integration with load errors and cache/tool-change warning. `--force` bypasses a meaningful cache warning; require informed confirmation, never add it automatically.
- **`/memory`.** Current: Blocked. Proposed: native instructions/auto-memory inspection before editing. Show effective scope and preserve managed files. Existing Files viewing is only partial parity.
- **`/import [codex|gemini|cursor] [--dry-run|--yes]`.** Current: Forwarded, not suggested. Proposed: dry-run preview candidate after verifying output; real import needs a reviewed file/config diff and consent. Never silently substitute `--yes` for an invisible picker.
- **`/login`, `/logout`, `/privacy-settings`.** Current: login/logout Blocked; privacy-settings Forwarded. Proposed: secure browser/account flow or local-only for now; avoid passing credentials through chat/logs. Logout affects shared credentials, not just the selected session.
- **`/setup-bedrock`, `/setup-vertex`, `/web-setup`, `/install-github-app`, `/install-slack-app`.** Current: Forwarded, not suggested. Proposed: local-only until dedicated provider/OAuth/repository-selection and credential handling exists. Availability must respect host/provider/account gates.
- **`/remote-env`.** Current: Forwarded, not suggested. Proposed: local-only or dedicated cloud-environment selection; no app support should be implied by a static suggestion.
- **`/bug [report]`; alias `/share`; `/feedback [report]`.** Current: Blocked. Proposed: native preview/redaction and explicit consent to send or save feedback. Reports can include session data; no silent forwarding or consent bypass.

- **`/chrome`, `/ide`.** Current: Blocked. Proposed: read-only integration status or dedicated host-browser/IDE setup, initially local-only for authentication and attachment changes. A configured MCP inventory does not cover these host integrations.
- **`/statusline [description]`.** Current: Blocked. Proposed: prompt-based/native configuration flow with preview and approval. It can write a shell command that the backend subsequently executes; this is not simply a harmless display preference.

### 5. Prompt-based skills, workflows and ongoing automation

These are not all terminal dialogs. Forwarding may be technically straightforward, but model usage, file changes, tool approvals, hidden confirmations and provider/account gates still need coverage. The repo's direct-API ban governs **our implementation**; it does not establish that a named CLI skill is installed, safe, free, or appropriate to run.

- **`/code-review [level] [target] [--fix|--comment|...]`; alias `/review`.** Current: Forwarded, not suggested. Proposed: catalog local review as a bundled-skill candidate, with explicit target/effort. `--fix`, `--comment` and cloud `ultra` are distinct mutation/sharing/spend forms. Keep cloud launch confirmation separate.
- **`/security-review`; `/simplify [target]`.** Current: Forwarded, not suggested. Proposed: bundled-skill candidates with actual result visibility and approval checks. `/simplify` applies changes, so it must not be labelled a read-only review.
- **`/doctor [prompt-audit [path]]`; alias `/checkup`.** Current: Blocked. Proposed: verify current bundled-skill behavior and ordinary approvals, rather than categorically banning a supposed fixed dialog. Its repair recommendations can modify files after consent. CLI `claude doctor` outside a session is a different surface.
- **`/debug [description]`.** Current: Forwarded, not suggested. Proposed: bundled-skill candidate with log-access/privacy notice; verify debug output is useful from the app and no sensitive log is automatically published.
- **`/run`, `/verify`, `/run-skill-generator`.** Current: Forwarded, not suggested. Proposed: bundled-skill candidates; distinguish observing an app from saving or committing a launch recipe. Rendering a browser app or terminal remains a platform-specific tool concern.
- **`/init`.** Current: Blocked. Proposed: argument/workflow-aware support after verifying ordinary versus optional interactive setup/import paths. Do not assume it is always a text response or always a dialog.
- **`/fewer-permission-prompts`, `/update-config [request]`.** Current: Forwarded, not suggested. Proposed: explicit prompt-based configuration changes with visible proposed edits, scope and approvals. Permission-changing skills require more scrutiny than diagnostic ones.
- **`/claude-api [subcommand]`.** Current: Forwarded, not suggested. Proposed: documentation/skill discovery only until individual subcommands' side effects and account needs are classified. Do not implement a separate Anthropic models/API client to emulate it. Commands that migrate code differ from managed-service onboarding.
- **`/dataviz`, `/artifact-capabilities`, `/artifact-diagramming`.** Current: Forwarded, not suggested. Proposed: bundled-skill candidates, gated by actual artifact/provider availability. Discovery does not authorize connector use or publishing.
- **`/design [brief]`, `/slides [brief]`, `/design-sync [hint]`.** Current: Forwarded, not suggested. Proposed: artifact/browser integration with clear upload/publish scope, not plain chat parity. `/design-sync` can upload repository design-system material. **`/design consent`, `/design revoke`, `/design-login`** are separate authorization forms and should remain explicit local/secure flows until implemented.
- **`/plugin-authoring`, `/workflow-authoring`.** Current: Forwarded, not suggested. Proposed: reference/skill candidates with visibility tied to enabled built-in/plugin features. Generated plugins/workflows are code and are not executed by catalog discovery.
- **`/subtask <task>`.** Current: Forwarded, not suggested. Proposed: verify inherited-context background-agent launch and result mapping into the Agents view. It differs from `/fork` creating a separate background session.
- **`/batch <instruction>`.** Current: Forwarded, not suggested. Proposed: integration around plan approval, worktrees and parallel agents. It may open PRs or modify multiple worktrees; generic tool cards alone do not guarantee lifecycle coverage.
- **`/deep-research <question>`.** Current: Forwarded, not suggested. Proposed: workflow launch candidate after confirming availability, approvals and visibility in Workflows. It can incur significant usage; don't invoke it merely to check that its name exists.
- **`/goal [condition|clear|stop|off|reset|none|cancel]`.** Current: Forwarded, not suggested. Proposed: native goal state plus cancellation/continuation and idle-stop policy before unattended support. Read-only bare status is a distinct candidate.
- **`/loop [interval] [prompt]`; alias `/proactive`.** Current: Forwarded, not suggested. Proposed: schedule/task lifecycle integration first, including listing, cancellation, limits and preserving the CLI process. A successful initial response does not prove scheduled work survives idle cleanup.
- **`/schedule [description]`; alias `/routines`.** Current: Forwarded, not suggested. Proposed: cloud-task integration with scope/account authorization and explicit create/update/run confirmation. Do not confuse with local `/loop` timers.
- **`/autofix-pr [prompt]`.** Current: Forwarded, not suggested. Proposed: dedicated cloud-session/PR watcher integration; it can push changes remotely, so launch, account and spending confirmation must remain visible.
- **`/ultrareview [target]`; `/code-review ultra ...`.** Current: Forwarded, not suggested. Proposed: dedicated cloud-review launch/result/spend handling, not unconditional approval through a text relay.

- **`/claude-in-chrome [task]`.** Current: Forwarded, not suggested. Proposed: bundled-skill candidate only when the host Chrome integration is actually enabled; consent, authenticated browser actions and visible tool results need verification. Opening the Controller's browser panel does not enable Claude's host-browser integration.

### 6. Terminal-specific, account/browser extras and removed commands

- **`/focus [on|off]`.** Current: Forwarded, not suggested. Proposed: native app focus layout if wanted; don't promise a phone layout change from toggling the local CLI renderer. Remote Control's special semantics are not automatically our interactive-PTY semantics.
- **`/theme`, `/scroll-speed`, `/keybindings`, `/terminal-setup`.** Current: theme/keybindings/terminal-setup Blocked; scroll-speed Forwarded. Proposed: app-native preferences or local-only where they configure the host terminal. No need to blindly reproduce terminal keybinding installation on a phone.
- **`/voice [hold|tap|off]`.** Current: Blocked. Proposed: local-only unless separate phone dictation is approved; the host microphone is not the phone microphone. Not part of the current attachment scope.
- **`/artifacts`.** Current: Forwarded, not suggested. Proposed: native artifact list/open integration with verified ownership/access and safe links. Attaching an artifact is outside the current no-attachments scope.
- **`/mobile`; aliases `/ios`, `/android`; `/radio`; `/stickers`; `/passes`.** Current: Forwarded, not suggested. Proposed: optional known external links/read-only notices or local-only. Eligibility and host/browser effects must be labelled; these are low parity priority.
- **`/upgrade`, `/usage-credits`; historical `/extra-usage`.** Current: Forwarded, not suggested. Proposed: safe user-opened billing link/request flow, never a credential-bearing automatic navigation or a silent plan change. Treat extra-usage as historical, not a proven current alias.
- **`/rate-limit-options`.** Current: Forwarded, not suggested. Proposed: native usage-limit recovery with explicit choices for waiting, automatic continuation and billing links. Automatic continuation changes unattended behaviour and billing actions require consent; do not send a hidden terminal menu or silently choose a paid option.
- **`/heapdump`.** Current: Forwarded, not suggested. Proposed: local-only diagnostic command, hidden from normal suggestions as upstream does. Heap snapshots can contain conversation and credentials; do not offer automatic preview/upload/download as harmless diagnostics.
- **`/pr-comments`.** Current: Forwarded, not suggested. Reference says removed in v2.1.91; suggest asking Claude to inspect PR comments instead. No need to build a relay for a removed command.
- **`/vim`.** Current: Blocked. Reference says removed in v2.1.92; explain `/config` → Editor mode instead. Separately, editor mode can affect existing picker key scripts and still requires verification.
- **`/ultraplan`.** Current: Forwarded, not suggested. Reference says removed; guide to plan mode instead of treating it as an available missing feature.

- **`/powerup`.** Current: Forwarded, not suggested. Proposed: local-only interactive lessons for now, or native help links; animated terminal tutorials do not translate to the phone by forwarding their name.

### 7. Dynamic commands are a separate inventory

- **User/project skills:** `/skill-name [arguments]`. Inspect actual locations, invocation visibility, supported frontmatter, reserved names and duplicate precedence; don't skip a large body when a small metadata prefix is enough. Keep read bounds and path safety. Discovery isn't invocation testing.
- **Legacy `.claude/commands` files:** preserve documented path-derived names/namespaces. Current parsing applies `name` to both skill and legacy files, but the [skills reference](https://code.claude.com/docs/en/skills.md) says legacy files do not support that field. Verify and fix naming before advertising commands that may not exist.
- **Plugin skills/commands:** `/plugin:skill [arguments]`. Installed cache entries and explicit configuration preferences are known; effective loading, custom manifest paths, managed policy and dependent components aren't fully represented. Keep namespace provenance and disabled/unknown labels.
- **MCP prompts:** `/mcp__server__prompt [arguments]` (confirm the exact runtime namespace before cataloguing). A configured MCP server does not establish a prompt list; transport/credentials must not be opened merely to guess names. Use a supported runtime discovery contract if available, otherwise mark unavailable to the catalog.
- **Bundled/account-synced skills and workflows:** document their gated availability; don't treat the official reference as a local filesystem list. Cloud-synced and nested/additional-directory discovery need separate scoping and trust decisions.
- **Stacked skills:** the reference permits up to six skills at the start of one message. Recognize a stack only as supported skill composition after testing it. Never assume an arbitrary second `/command` is a harmless skill; don't silently chain lifecycle or permission commands.

## Implementation sequence

### Step 1 — Truthful catalog, no expanded execution

- Replace hand-maintained name arrays with a reviewed **data manifest** of commands, aliases and forms. Fields: canonical name, source class, syntax/form matcher, documented availability/version constraints, intended transport, effects, app coverage, verification evidence and fallback.
- Add the missing official entries and alias relationships to the *planning/catalog* layer, including deprecated migration hints; runtime visibility still needs separate discovery. Keep hidden/sensitive diagnostics out of ordinary suggestions.
- Make policy explicit for **known but unimplemented** commands. Unknown user skills are not the same category. No generic fallback should quietly treat a known lifecycle/auth/permission action as a harmless custom skill.
- Fix broad over-blocking by modelling explicit forms, but don't enable a form until its probe succeeds. Alias policies must be identical to their canonical command.
- Render concise groups: **Available in app**, **Needs verification/integration**, **Local CLI**, **Removed**. Expand explanations on demand; reserve Retry for a failed read, not documentation caveats or entry limits.
- Repair bounded metadata-prefix discovery, legacy naming and visible truncation reporting. This addresses the warnings the user reported without claiming a complete live catalog.

### Step 2 — Reuse native app surfaces

- Wire `/model`, `/effort`, `/diff`, `/workflows`, `/help` and the supported subset of `/tasks`, `/status`, `/skills`, `/mcp` to app views with coverage labels.
- Review model/effort **scope and persistence**, particularly session-only `max` and session-only model selection, before calling the native redirect equivalent.
- Add clear read-only response cards for informational results. No host clipboard actions masquerading as phone Copy.
- Keep unsupported sub-controls disabled with a reason rather than swallowing the command or writing to a hidden picker.

### Step 3 — Probe inexpensive explicit forms first

Candidate order: `/agents`, `/effort status`, `/reload-skills`, `/rename <name>`, `/context all`, `/compact <instructions>`, `/output-style <style>`, then advisor/autocompact and narrowly allowlisted `/config` keys. This is an investigation order, **not** a list already safe to enable. Configuration-changing cases use isolated probe settings and must not overwrite the user's defaults.

For each form, record: accepted syntax, account/version gate, structured confirmation, output visibility, persistence scope, busy-session semantics, failure/cancellation and reconnect behaviour. Test known aliases separately where dispatch might differ. A passing picker fixture or pure policy function is not a passing CLI command.

### Step 4 — Session and path transitions

Resolve startup/trust/auto-mode dialogs in a controlled disposable session **before** entering transition commands. Record SessionStart/PID/transcript IDs, cwd, controller spawn-token routing, queue and pending response ownership, agent/workflow association and stored settings. Test both idle and busy cases. Support through explicit native create/resume/rebind operations rather than guessing state from a repaint.

If those signals cannot safely establish new ownership, the command remains local-only with an app alternative. Do not relax guards because a probe was inconclusive.

### Step 5 — Higher-risk integrations

Permissions/additional directories, plugin install/reload, live MCP actions/auth, checkpoint restore, goal/schedule lifecycles and cloud handoffs each get their own design, confirmation UX and security review. Browser/account consent and process/liveness ownership are requirements, not polish. Keep the current no-direct-API/Agent-SDK and no-product-PTY-output-parsing constraints unless the user explicitly revisits them.

## Per-form acceptance checklist

- Discoverable only with honest source/availability labels; alias resolves to the same policy.
- Selection does not execute; arguments and quoted/path text survive unchanged or are explicitly rejected.
- User can see completion, errors and any confirmation; no invisible prompt hang or speculative retry that grants consent.
- Model/session/cwd/permissions/queue remain correct; scope/persistence is stated before mutation.
- Reconnect, cancellation, long output and phone layout exercised.
- PR review for every implementation change; security review for file, process, permission, configuration, credential, publishing or network boundaries.
- Bounded fixtures and approved live probes; record what was actually run. Do not add permanent tests without the user's request.
- Incremental commits; update the manifest/checklist when support or CLI evidence changes.

## Sources and next decision

Primary references: [Commands](https://code.claude.com/docs/en/commands.md), [Skills](https://code.claude.com/docs/en/skills.md), and the local [transition probe](session-transition-probe.md). Argument forms above are descriptions from the retrieved rolling reference, not promises about installed 2.1.328.

Local behaviour anchors: `packages/common/src/commands.ts`, `packages/frontend/src/components/layout/InputBar.tsx`, `packages/frontend/src/hooks/use-sessions.ts`, `packages/backend/src/services/command-catalog.service.ts`, `packages/backend/src/services/plugin-command-catalog.ts`, and `packages/backend/src/services/ws.service.ts`.

**Proposed first implementation slice:** Step 1's accurate manifest/alias coverage and concise catalog UX, followed by Step 2's native shortcuts. Do not start by enabling every documented name, and do not call a blocked command permanently impossible merely because its terminal picker is not yet represented.
