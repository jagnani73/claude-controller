# Read-only Claude shell jobs

## Integration

Render `ShellJobsPanel` from `packages/frontend/src/components/workspace/ShellJobsPanel.tsx`
with `{ sessionId: string }` inside the selected workspace tab. **Unmount it when hidden**:
it polls snapshots every 2 seconds and selected output every 1.5 seconds while Follow is enabled.
The enclosing session view owns the existing session subscription; this panel does not subscribe,
resume, spawn, or stop a CLI. It uses `shell_jobs_request` / `shell_jobs_snapshot` and
`shell_job_output_request` / `shell_job_output` from `common/shell-job-types`.
No Files/Changes or interactive Terminal implementation is involved.

The session owns `ShellJobs`. TranscriptWatcher forwards parsed entries (including structural
`toolUseResult`) on both initial drain and live tail. The initial drain reconstructs the registry
before snapshot replies (`session.ready`). Hooks update the same registry synchronously and return
`{}` without holding the CLI. There is no database or persisted controller-side cache.

## Evidence and authority

Targeted probe evidence was captured with CLI **2.1.323**; the last fully verified release remains
**2.1.322**. This feature does not change `CLAUDE_CODE_TARGET_VERSION`.

- Bash `PostToolUse.tool_response.backgroundTaskId`, or JSONL `user.toolUseResult.backgroundTaskId`,
  associates an opaque job ID with the original tool-use ID. The Bash input provides command and
  description. `run_in_background` alone is not launch proof.
- Stop's `background_tasks` is a turn-end snapshot, not a continuous process monitor. Known shell
  jobs with explicit running status can re-establish liveness. Absence does not mean completion.
- Completion arrives in a user entry with `origin.kind = task-notification`,
  `origin.producer = session-task`, `promptSource = system`, and `turnOrigin = task_notification`.
  Only after that structural check is the task-notification XML read, and its job ID **and** tool-use
  ID must match a known launch. Queue-operation entries are not counted as a second completion.
- Internal notification text never emits `user_prompt`; mixed tool-result blocks are preserved.
  Ordinary user XML is not interpreted as lifecycle metadata and stays ordinary chat.
- TaskStop's successful structured result names `task_id` and `task_type: local_bash`.
- No PID or dedicated numeric exit-code field was observed. `completed` is not a claim of exit 0;
  neither summaries nor output footers are parsed for an exit code. The UI always says unavailable.
- Historical launches reconstruct as `unknown`; they do not block idle stop. Live known running
  jobs do block idle stop. PTY death, disposal, or respawn settles running jobs to unknown, not
  stopped/completed. Terminal job states do not get resurrected by duplicate launch records.
- Hook cwd is session context, **not** the child command's effective cwd.

## Output confinement and bounds

The PTY passes its actual child environment to the registry before spawning. Expected root is
`TEMP`/`TMP` on Windows, or `TMPDIR` (default `/tmp`) on POSIX, followed by `claude`.
`CLAUDE_CODE_TMPDIR` overrides are unverified and refuse output. Only the observed
`<root>/<opaque bucket>/<session-id>/tasks/<job-id>.output` layout is allowed.

Clients send session/job IDs and an optional byte offset, never paths. Paths appearing in hooks,
transcripts, or tool result strings grant no filesystem authority and are not used. IDs are bounded
ASCII basename tokens (Windows device names rejected); separators, ADS syntax, and traversal are
rejected. Discovery visits at most 128 direct temp-root children, no recursive scan. Ambiguous
matches and unknown layouts return unavailable. Every path component is checked with lstat and
realpath; linked/junction components and non-regular files are refused. Open uses O_NOFOLLOW where
supported, compares pre-open and handle identities, revalidates the path, reads from that single
handle, and closes it in finally. The opened handle's stat must have `nlink <= 1`; hard-linked
files return an explicit unavailable error before any output read. This reduces path races but
does not eliminate ancestor TOCTOU: Node's portable APIs cannot provide an
atomic openat-style chain on Windows against a hostile local actor simultaneously replacing every
ancestor. Tails are not a security boundary against arbitrary local process/filesystem control.

Registry limits: 128 jobs, 512 recent relevant tool-call mappings, 2,048 code units per display field.
Once the job cap is reached, additional jobs are explicitly omitted; don't use the panel as an
exhaustive process inventory. Snapshot payloads and retained metadata are therefore bounded.
Output is capped at 32 KiB per request, one read in flight per session, with per-socket request
throttling and WS buffered-output checks. Each read allocates only its bounded range, never the
whole file. Cursor resets/truncation are explicit; incomplete trailing UTF-8 bytes are withheld
until the next request. Frontend output retains at most 64 Ki code units. The panel renders React
text in a pre element: no HTML, ANSI terminal interpreter, OSC links, or executable output.

There are no backend polling timers, open subscriptions, or persistent output descriptors.
Reads happen only on request from a currently session-subscribed socket. Responses after disconnect
or subscription changes are discarded; an in-flight bounded read closes its handle even if the
session shuts down. Component cleanup removes listeners and timers. Refresh/retry, empty/error,
truncated-tail, follow, and copy-visible-output controls are read-only.

Refresh and polling share one in-flight coordinator per channel. Bounded optional request IDs
are validated and echoed by the backend; the panel only accepts its current request ID, so late,
duplicate, timed-out, or previous-selection responses cannot append output. Both channels report
a six-second timeout (including silent throttle/backpressure drops) rather than imply empty data.
Follow only controls polling and scroll: toggling it retains text and cursor. Disconnect invalidates
pending requests without clearing visible output; reconnect retries selected output even while
paused, also retrying after the owning session subscription's history marker. No safety gates are
bypassed. Clients continue to send IDs and byte offsets only, never output paths.

## Remaining unverified paths

Subagent-owned shell jobs are excluded (agent hooks and sidechain user metadata); task storage and
ownership for them need a separate live probe. Crash liveness is inherently unknown without a fresh
CLI signal. Nonzero-exit notification contracts were not captured: explicit `failed` is understood,
but no numeric exit is inferred. Alternate temp layouts, bucket counts above the bound, path case
aliases/symlinks, and evicted tool mappings may make output or attribution unavailable. There is no
external stop/input/foreground RPC, TaskOutput fallback, process enumeration, or PTY stdout parsing.
Output files survive CLI exit, but this initial panel requires a session registry (resume reconstructs
it); it does not independently browse stopped sessions from disk.

## Verification

Temporary synthesized JSONL/hook and temp-directory assertions exercised launch proof, replay,
deduplication, forged ordinary XML, internal notifications not emitting user_prompt, unknown restart
state, split UTF-8 tails, byte caps, path traversal, junction escape rejection, and lifecycle closure.
The fixture was removed after execution. No permanent tests or live CLI probes were added.
