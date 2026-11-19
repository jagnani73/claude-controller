# Workflow observation

## Verification scope

The registry was compared read-only against an existing workflow journal (four phases, 108 observed agents at that snapshot). Temporary checks exercised journal chunk/UTF-8 boundaries, large-tail offsets, duplicates, caps, provenance, concurrent reads and usage-budget handling; the existing 117-test suite also passed. Temporary pure/render assertions covered formatting and basic panel states. Browser instrumentation confirmed a zero-run opener, phase rendering and open-panel polling in a synthetic mounted fixture.

A complete live CLI-to-phone run, agent-history interaction, hidden/disconnected recovery, and the full responsive viewport matrix have **not** all been exercised in a browser. Those remain verification gaps, not claimed passes. No new workflow was executed or API credit spent for this feature's verification. The last fully verified CLI relay version remains unchanged.

The Workflows strip and panel are **read-only**. They do not launch, stop, pause, restart, or otherwise control a workflow or its agents. They show only what this session has observed; absence of a run or agent is not proof that none exists. A zero-run session still has an opener.

## Structured evidence

The integration was observed on Claude Code 2.1.326; it is an implementation contract, not a guarantee about future CLI versions. The session's main transcript supplies an assistant `Workflow` tool call and a matching user `tool_result` whose top-level `toolUseResult` has `taskType: "local_workflow"`, a safe `runId`, and optionally `taskId`. Calls from sidechains are ignored. The controller derives the run directory from the session's own transcript location, not paths supplied in the result.

The corresponding `subagents/workflows/<runId>/journal.jsonl` contains JSONL records observed as `launched`, `started` (including `key`, `agentId`, `label`, and `phase`) and `result` (including `key`, `agentId`, `result`, and `toolsUsed`). Results join to starts by agent ID; a null or absent result is failure, a non-null result is a produced value. Result bodies are not sent through the workflow snapshot. Agent files can contribute additional recorded agents when the journal is incomplete. Declared phases may be empty and counts cover **observed agents only**, not future scheduled work.

The launch script's `const meta` may supply a name, description and phase titles/details. The controller scans only the script head and accepts literal values, never executing or importing it. Computed values, interpolation and spreads cannot be relied on; missing or unreadable metadata falls back to a run ID and observed phases. This is not a general JavaScript parser.

An agent is `running` only on explicit current-process `SubagentStart` evidence not followed by `SubagentStop`, subject to the bounded evidence lifetime; history, journal entries and file timestamps do not prove liveness. A journal result marks an agent completed or failed; otherwise it is recorded or running. A run is `running` only while an observed agent has live evidence; otherwise it is `observed`, unless a matching CLI task notification supplies the terminal `completed`, `failed`, or `stopped` outcome. Completion of all observed agents does not prove the workflow finished. Process stop or respawn clears live evidence; a resumed transcript alone never recreates it.

An agent's model and context may come from the latest assistant entry in a bounded transcript tail. Context is input plus cache-read and cache-creation input tokens for that one request, **not** cumulative tokens, output tokens, cost, or spend. Values may be absent or arrive over several snapshots; last-known usage values are retained only while a validated transcript is present. An agent can open a transcript only if the existing agent registry exposes a safe stream; the stream is read-only and may be unavailable, with Retry offered.

## Delivery and limits

One session-view hook owns snapshot polling for both strip and panel: after the session subscription is attached, visible pages poll every 2 seconds while open and every 10 seconds while closed. Hidden pages do not poll. Requests are correlated by ID, one at a time, and spaced to respect the server's minimum gap; offline requests are not queued. Reconnect waits for the session subscription to attach again. A missing reply times out after 8 seconds and shows an error with Retry while retaining any previous list; a successful snapshot clears the error.

Reads and output are bounded: at most 20 runs, 300 agents per run and 40 phases; large journals and excessive entries can be truncated, with notices where applicable. Reads are incremental, agent usage has a per-snapshot time budget, and missing, unreadable, malformed or unsafe files can leave partial data. The panel reports relevant notices and truncation rather than claiming completeness. Safe path segments and filesystem checks prevent client-chosen paths from determining what is read. These constraints make the view observational rather than an authoritative workflow scheduler or audit log.
