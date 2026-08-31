# CLI verification harness

Run these when bumping `CLAUDE_CODE_TARGET_VERSION`.

That constant carries a promise — *"bump only after re-verifying the relays against
the newer CLI"* — and these scripts are what makes it checkable. Without them,
re-verifying means reconstructing the checks from memory each time.

```bash
pnpm build                  # probes read from dist, not src
pnpm verify:hooks           # do our hook events still fire?
pnpm verify:model-switch    # does PostModelSwitch still carry requested_model?

pnpm dev:backend            # required for the next one only
pnpm verify:approval-edit   # does approving with updatedInput run the edited call?
```

`verify:approval-edit` needs a **running backend**: `PermissionRequest` does not
fire under headless `claude -p` (there is nobody to prompt) and did not reproduce
in a bare PTY either. A real controller session is the only place it fires. The
other two spawn the CLI directly and need nothing running.

Exit codes: `0` pass, `1` a real regression, `2` inconclusive (the probe itself
failed — fix that before reading anything into the result).

## These cost plan credits

Each probe spawns a real Claude Code session and sends a prompt. They are not
unit tests and are deliberately excluded from `pnpm test`, which is pure logic
only. Run them deliberately, not in a loop.

## What each one guards

| Script | Guards against |
|---|---|
| `hooks-fire.mjs` | Hook events silently no longer firing; safe mode no longer suppressing them (either direction is a surprise worth knowing). |
| `model-switch.mjs` | `PostModelSwitch` disappearing, or `requested_model` being renamed — which would degrade model reconciliation to family-matching with no error. |
| `approval-edit.mjs` | The two PermissionRequest response shapes diverging. `updatedInput` is honoured only in the schema form; on the flat form the CLI discards the whole response, loses the allow, and falls back to a terminal picker the phone cannot see — the session hangs with no error. Verified to genuinely fail by reverting the shape. |

## Every probe has a control

Each script asserts a **control** case that is expected to fire, and reports
`INCONCLUSIVE` (exit 2) if it doesn't.

This is not ceremony. An earlier version of the safe-mode probe reported "0 hooks
fired in all three cases" — which looked exactly like a finding, but was actually
`shell: true` on Windows concatenating argv unescaped and truncating the prompt
to its first word, so no tool ever ran. A result without a control cannot
distinguish "the CLI changed" from "the probe is broken."

## What this does NOT cover

**The keystroke relays.** `question.input.ts` and `plan.input.ts` drive ink
pickers by synthesising navigation, and they are the most fragile thing in the
project — a picker gaining one option silently changes what a digit key selects.
They need an interactive PTY and a human reading the result, so they remain a
manual step:

1. Start the controller (`pnpm dev:backend`, `pnpm dev:frontend`).
2. Ask a session to call `AskUserQuestion`; answer a **non-default** option and
   confirm the `tool_result` echoes the option you actually picked.
3. In a plan-mode session, ask for a plan, approve via **Approve · manual**, and
   confirm the mode badge flips to `DEFAULT`.

Treat a green run here as "the hook contracts held", not "the relays work".

## Configuration

`CLAUDE_BIN` overrides which binary is tested. Otherwise the probes look in
`~/.local/bin` — deliberately **not** PATH, because this project has already been
bitten by a machine with two installs where PATH order selected a build 31
versions behind the intended one.
