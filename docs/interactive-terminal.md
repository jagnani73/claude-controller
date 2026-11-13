# Independent interactive terminals

Integration: `SessionView` lazy-loads `components/workspace/TerminalPanel` and
passes `<TerminalPanel sessionId={sessionId} />` through WorkspacePanel's terminal
slot. A separate lazy ShellJobsPanel occupies the read-only Jobs tab. Only the
selected tab mounts; closing the workspace unmounts all its panels without
unmounting the chat or composer.
`@xterm/xterm`, FitAddon and xterm CSS load dynamically when this panel is used.
Mount/reconnect only list or subscribe; **New terminal** is the only creation
path. A second explicit **Take control** action enables input/resize. Unmount
releases control and disposes xterm, not the shell. Remount reconstructs the
bounded screen; reconnect with the same screen resumes from its rendered byte
cursor. No terminal input is buffered offline or retried automatically.

Terminal lists are scoped to the current Claude session, not a machine-wide
shell list or the folder currently being browsed in the sidebar. Two sessions
in the same folder still have independent terminal lists. The displayed cwd is
the **starting folder**: typing `cd` inside a shell does not reassign ownership.
This is list/process association, not filesystem confinement.

**Remove** immediately deletes an exited/error terminal's retained output; no
native browser dialog is needed. **Close** on a running terminal uses an in-panel
confirmation before stopping its shell/jobs. The server confirms removal with
`terminal_removed` to all subscribed viewers, so selection and output clear
consistently. Cleanup after removal is idempotent.

## Trust and ownership

This exposes arbitrary machine commands as the backend OS user. It is **not a
sandbox**, does not confine commands to cwd, and is not a new authorization
boundary. Existing Tailscale/Caddy and WS origin checks remain responsible for
access. Any trusted client can list/read a session's terminals and explicitly
claim one when unowned. Exactly one WS owns input/resize at a time; another client
cannot steal ownership or close a controlled shell. Disconnect/unsubscribe
releases control. A terminal id is a random UUID, always checked against its
session association. No client-supplied cwd, executable or shell command is used
at spawn: cwd comes from an existing Session config, realpathed and checked with
path-segment containment under realpathed server workDir. This is a spawn-root
check, not a filesystem jail or protection from a local user replacing paths.

The independent TerminalManager, process host and node-pty never reference a
Claude PTY, hooks, transcript, SessionBus, or orphan-reaper registry. Agent task
execution is unaffected. All CLAUDE*/ANTHROPIC_* environment variables and Node
injection/identity variables plus Python/dynamic-loader injection variables are
stripped. Normal user environment (including
credentials for tools) remains available intentionally, as in a local shell.
No output is persisted or logged by the terminal feature.

Windows defaults to Program Files/PowerShell/7/pwsh.exe only when its canonical
path is exactly the expected trusted install path; otherwise built-in Windows
PowerShell. PATH and repository executables are never used for shell selection.
Profiles are disabled; console encoding is explicitly UTF-8. A separate
PowerShell launcher assigns itself to a kill-on-close Job Object **before**
launching the PTY host, then all descendants inherit ownership without breakaway.
EOF on the backend pipe, normal exit or close terminates the owned tree. No
`taskkill`, delayed PID signal or persisted PID registry is used.

Linux uses the account shell from /etc/passwd only when listed in /etc/shells,
otherwise /bin/sh. A Python 3.9+ supervisor is the PTY session leader and Linux
subreaper. A private mode-0600 FIFO provides parent liveness. Shutdown freezes
owned descendants and uses pidfds (stable kernel process handles), including
adopted jobs, before killing them. Unsupported pidfds fail before shell exec.
Other POSIX platforms currently **fail closed** rather than guess at process
ownership; macOS/BSD support is not implemented. This is an explicit limitation.

## Resource and lifecycle limits

- 3 retained terminals/session, 12 total (exited entries count until Remove).
- 20–240 columns, 5–100 rows; 8 KiB input/output chunks.
- 256 KiB retained UTF-8 output, additionally capped at 8192 chunk records.
- Absolute byte offsets; explicit terminal_gap when requested history was lost.
- 64 KiB unacknowledged renderer window, ACK only after xterm write callback.
- 256 KiB terminal contribution to a WS send buffer; no per-client output queue.
- 64 KiB host/input queue, 64 KiB/s input, 120 non-ACK terminal requests/s/client.
- 64 KiB terminal request envelope (checked after JSON parse). The shared WS
  retains its original `ws` default 100 MiB payload allowance before JSON parse,
  not a terminal-specific global cap: chat prompts/card answers may exceed 1 MiB.
- Render ACKs coalesce to one latest cursor and retry every 50 ms for at most
  5 seconds on the same socket/subscription; exhaustion reconnects to resume.
  Selection changes, reconnect and cleanup cancel the retry. Input never retries.
- Unsubscribe is synchronous: if the bounded send cannot accept it, the socket
  is closed and replaced rather than queueing a release that could hit a newer
  viewer. This also reconnects shared chat through its normal recovery path.
  Backend disconnect cleanup releases ownership (a dead peer is heartbeat-reaped).
- PTY output pauses when the host pipe backs up. node-pty 1.1.0's platform write
  queues are checked because its public write API has no backpressure; an unknown
  queue shape or overflow fails closed and stops the shell rather than accumulating.
- 16 viewers/terminal; creation UUID receipts capped at 4096/server lifetime.
  Receipts are never evicted/reused: repeat creation returns the same shell or a
  finished-request error. Restart forgets terminals and receipts; the UI never
  automatically resends creation after reconnect/restart.
- 30-minute user-input/claim idle stop (output alone does not keep a shell alive).
  `TERMINAL_IDLE_MINUTES=0` disables; invalid values use 30. Active long-running
  jobs are stopped after this timeout too; configure appropriately.
- 15-second startup timeout, 10-second UI request timeout (20 seconds create).
  Timeout does not claim success; input is never auto-retried. Retry creation
  uses its original request UUID. Server close disposes manager/timer/PTY pipes
  and terminates WS clients so disconnect listeners run.

ANSI rendering is xterm, not HTML; no custom link opener or clipboard-write OSC
handler is installed. Ctrl/Cmd+C copies a selection; unselected Ctrl+C remains
interrupt. Large pastes are rejected visibly rather than partially queued. Mobile
Esc/Tab/Ctrl/interrupt/Copy/Paste controls are present. Read-only views follow the
controller's dimensions and never resize the shared shell.
