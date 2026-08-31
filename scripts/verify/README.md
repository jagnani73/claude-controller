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

pnpm dev:backend            # required for the next one only
pnpm verify:approval-edit   # does approving with updatedInput run the edited call?
```

`verify:approval-edit` needs a **running backend**: `PermissionRequest` does not
fire under headless `claude -p` (there is nobody to prompt) and did not reproduce
in a bare PTY either. A real controller session is the only place it fires. The
others spawn the CLI directly and need nothing running.

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
| `approval-edit.mjs` | The two PermissionRequest response shapes diverging. `updatedInput` is honoured only in the schema form; on the flat form the CLI discards the whole response, loses the allow, and falls back to a terminal picker the phone cannot see — the session hangs with no error. Verified to genuinely fail by reverting the shape. |
| `permission-cycle.mjs` | The Shift+Tab cycle gaining or losing a stop. `cycleDistance()` writes a keystroke count from `cycleCanIncludeAuto()`; if that count is wrong the session lands in a permission mode the phone did not pick, and the JSONL only records the mode in a periodic metadata block — so the *next prompt runs* under the wrong mode before anything corrects it. Caught `opusplan` being wrongly excluded from auto. |
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

## What this does NOT cover

**The plan picker.** `plan.input.ts` drives its ink picker by *digit* key, and
the mapping is position-sensitive: at high context usage the CLI inserts a
"clear context" approve at position 1, shifting the others down (see the KNOWN
LIMITATION in that file). Reproducing high context on demand is the hard part,
so it stays a manual step:

1. Start the controller (`pnpm dev:backend`, `pnpm dev:frontend`).
2. In a plan-mode session, ask for a plan, approve via **Approve · manual**, and
   confirm the mode badge flips to `DEFAULT`.

The AskUserQuestion relay **is** covered now, by `question-relay.mjs`. An earlier
version of this file claimed a picker selection could not be read off the
screen; that was reasoning, not evidence, and it was wrong. The picker marks the
focused option with `❯`, and the committed answer is echoed as
`⎿ · <question> → <answer>` — both machine-readable. The probe reads the cursor
*position* rather than the label, because stripping ANSI collapses the option
list onto one line and ink draws each label twice (`1. RedRed`).

Treat a green run as "the hook contracts held, Shift+Tab lands where we think,
and the question relay selects what it was asked for" — not "every relay works".

## Configuration

`CLAUDE_BIN` overrides which binary is tested. Otherwise the probes look in
`~/.local/bin` — deliberately **not** PATH, because this project has already been
bitten by a machine with two installs where PATH order selected a build 31
versions behind the intended one.
