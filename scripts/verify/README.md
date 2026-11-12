# CLI verification harness

Run these when bumping `CLAUDE_CODE_TARGET_VERSION`.

That constant carries a promise — *"bump only after re-verifying the relays against
the newer CLI"* — and these scripts are what makes it checkable. Without them,
re-verifying means reconstructing the checks from memory each time.

```bash
pnpm build                  # probes read from dist, not src
pnpm verify:hooks           # do our hook events still fire?
pnpm verify:model-switch    # does PostModelSwitch still carry requested_model?
pnpm verify:permission-cycle # does Shift+Tab still walk the cycle we predict?
pnpm verify:question-relay  # does the picker relay still select the option asked for?

pnpm dev:backend            # required for the next three only
pnpm verify:approval-edit   # does approving with updatedInput run the edited call?
pnpm verify:agents          # do agents, names, SendMessage traffic and per-agent history reach the controller?
pnpm verify:plan-relay      # does a fast tap on the plan card still approve via the picker?
```

`verify:approval-edit` needs a **running backend**: `PermissionRequest` does not
fire under headless `claude -p` (there is nobody to prompt) and did not reproduce
in a bare PTY either. A real controller session is the only place it fires.
`verify:agents` and `verify:plan-relay` need one too, because what they check
lives in the controller. The others spawn the CLI directly and need nothing running.

Exit codes: `0` pass, `1` a real regression, `2` inconclusive (the probe itself
failed — fix that before reading anything into the result).

## These cost plan credits

Each probe spawns a real Claude Code session and sends a prompt. They are not
unit tests and are deliberately excluded from `pnpm test`, which is pure logic
only. Run them deliberately, not in a loop.

`verify:permission-cycle` is the exception: it drives the TUI but never submits
a prompt, so it costs nothing. It is still not a unit test — it needs the real
binary and about a minute of wall clock.

## What each one guards

| Script | Guards against |
|---|---|
| `hooks-fire.mjs` | Hook events silently no longer firing; safe mode no longer suppressing them (either direction is a surprise worth knowing). |
| `model-switch.mjs` | `PostModelSwitch` disappearing, or `requested_model` being renamed — which would degrade model reconciliation to family-matching with no error. |
| `approval-edit.mjs` | The PermissionRequest response shape drifting. `updatedInput` is honoured only in the schema form; a response the CLI does not honour loses the allow and falls back to a terminal picker the phone cannot see — the session hangs with no error. Verified to genuinely fail by reverting the shape. It covers the **edit** path only: on 2.1.322 the old flat `{permissionDecision}` form stopped working for a plain allow and deny too (found by hand, not by this probe), so re-test those by hand when touching `buildApprovalResponse`. Rejected edits and the PermissionRequest hook's `onFailure: "block"` denials are not probed; their evidence is in `docs/architecture.md`. |
| `permission-cycle.mjs` | The Shift+Tab cycle gaining or losing a stop. `cycleDistance()` writes a keystroke count from `cycleCanIncludeAuto()`; if that count is wrong the session lands in a permission mode the phone did not pick, and the JSONL only records the mode in a periodic metadata block — so the *next prompt runs* under the wrong mode before anything corrects it. Caught `opusplan` being wrongly excluded from auto, and `haiku` gaining the auto stop on 2.1.322. |
| `agents.mjs` | The agents view losing a source with no error. Runs a real two-teammate team through a running controller and asserts: agents arrive over `agent_update` (SubagentStart/Stop), they carry names (`agent-<id>.meta.json` still read), at least one agent-to-agent `SendMessage` arrives as `agent_message`, `subscribe_agent` replays an agent's own transcript, and a subscribe for an unknown agent gets `agent_unavailable`. A teammate that sent an approving `shutdown_response` must end `done`; if no teammate got that far the run says so instead of failing. Parent links are not asserted: teammates hang off the lead and the probe spawns no nested subagent. Teammates legitimately have no `toolUseId`, so only an unnamed agent lacking one counts as a lost parent link. Control: `INCONCLUSIVE` if no agent ever arrives. |
| `plan-relay.mjs` | The plan card answering into the void. The card is drawn from PreToolUse ~2.4s before the CLI renders its picker; a digit written in that window went into the main prompt box, and the picker stayed open with nothing on the phone able to answer it. The controller now waits for the picker-open signal (ExitPlanMode's notification-only PermissionRequest). The probe plans in a plan-mode Sonnet session, answers **approve-manual 500ms after the card**, and asserts a non-error tool_result and the mode becoming `default`. Control: `INCONCLUSIVE` if no ExitPlanMode card arrives. |
| `question-relay.mjs` | The AskUserQuestion picker changing shape under a script that still "succeeds". Drives the real `buildKeystrokes` and asserts the CLI committed the option asked for. Verified to genuinely fail by neutering the DOWN key: the probe reported `committed "Red", not the requested "Green"`. |

## Every probe has a control

Each script asserts a **control** case that is expected to fire, and reports
`INCONCLUSIVE` (exit 2) if it doesn't.

This is not ceremony. An earlier version of the safe-mode probe reported "0 hooks
fired in all three cases" — which looked exactly like a finding, but was actually
`shell: true` on Windows concatenating argv unescaped and truncating the prompt
to its first word, so no tool ever ran. A result without a control cannot
distinguish "the CLI changed" from "the probe is broken."

For `permission-cycle.mjs` the control is two-part, because it reads a rendered
surface: the TUI must first report `default` (proving the footer is readable and
the spawn took the `--permission-mode` we passed), and Shift+Tab must then change
what it reports (proving keystrokes are landing). Without both, "auto never
appeared in the cycle" is indistinguishable from "the TUI never rendered."

## Readiness for controller probes

The probes that drive a running controller wait for the session's first
`status_line` before sending a prompt, with a bounded fallback (`waitForReady` in
`lib/controller.mjs`, 50s): with `remoteControlAtStartup` the CLI sits at
"/rc connecting…" and the first render can lag well past boot while the prompt is
already usable. Each run prints which signal won (`status_line` or `timer`).

## What this does NOT cover

**The plan picker at high context.** `plan-relay.mjs` covers the normal-context
picker. The mapping is position-sensitive, though: at high context usage the CLI
inserts a "clear context" approve at position 1, shifting the others down (see the
KNOWN LIMITATION in `plan.input.ts`). Reproducing high context on demand is the
hard part, so that variant stays a manual step:

1. Start the controller (`pnpm dev:backend`, `pnpm dev:frontend`) and fill a
   plan-mode session's context until the picker offers "clear context".
2. Approve via **Approve · manual**, and confirm the mode badge flips to `DEFAULT`.

The **planless** two-option picker ("Exit plan mode? 1. Yes / 2. No") is not
probed either: it needs the model to skip writing a plan, which it does not do
reliably on request through the controller. Its rule (never send `2` for a
planless input) is documented in `plan.input.ts`.

The AskUserQuestion relay **is** covered now, by `question-relay.mjs`. An earlier
version of this file claimed a picker selection could not be read off the
screen; that was reasoning, not evidence, and it was wrong. The picker marks the
focused option with `❯`, and the committed answer is echoed as
`⎿ · <question> → <answer>` — both machine-readable. The probe reads the cursor
*position* rather than the label, because stripping ANSI collapses the option
list onto one line and ink draws each label twice (`1. RedRed`).

The cursor glyph changed under it once already: `❯` up to 2.1.251, ASCII `>` on
2.1.322. The probe accepts both, but only directly before an option of its own
question, since a bare `>` appears elsewhere on screen.

Treat a green run as "the hook contracts held, Shift+Tab lands where we think,
the question relay selects what it was asked for, and a fast plan tap lands" —
not "every relay works".

## Configuration

`CLAUDE_BIN` overrides which binary is tested. Otherwise the probes look in
`~/.local/bin` — deliberately **not** PATH, because this project has already been
bitten by a machine with two installs where PATH order selected a build 31
versions behind the intended one.

`CONTROLLER_WS` points the controller probes at a backend other than
`ws://127.0.0.1:4577`. `VERIFY_CWD` sets the session cwd for the probes that use
the repo by default (`permission-cycle`, `question-relay`, `approval-edit`,
`agents`, `plan-relay`): use it from a checkout the CLI has never trusted (a fresh
worktree, where the folder-trust dialog swallows the prompt) or one outside the
backend's `WORK_DIR`. `hooks-fire` and `model-switch` use the process cwd.
