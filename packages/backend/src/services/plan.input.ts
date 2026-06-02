// Translates an `ExitPlanMode` plan-picker response into raw bytes that drive
// Claude Code's ink picker via PTY stdin — the same relay approach as
// AskUserQuestion (the picker isn't HTTP-hookable, so we synthesize keystrokes).
//
// Navigation (reverse-engineered from `claude-code-source/src/components/
// permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`
// `buildPlanApprovalOptions`, verify against `dump/captures/*.raw`):
//   - The picker commits on a NUMBER KEY (use-select-input digit handler). At
//     normal context the option order is stable: `1` = the elevated keep-context
//     approve ("use auto mode" when available, else "auto-accept edits"),
//     `2` = "manually approve edits" → default mode. (`3`+ shift with the model /
//     ultraplan / context, so we never use them.)
//   - Esc (`\x1b`) keeps planning (dismisses the picker, stays in plan mode) —
//     this is the Stop action.
//
// KNOWN LIMITATION (accepted): at HIGH context usage Claude inserts a
// "clear context" approve at position 1 (`showClearContext`), shifting the
// elevated approve to 2 and manual to 3 — so `1`/`2` would mean the wrong
// thing (and `1` would also clear context). We can't detect that without the
// statusline context% (deliberately not a data source), so the mapping is
// correct at normal context and best-effort at high context.

import type { PlanDecision } from "common/types";
import type { KeystrokeChunk } from "./question.input.js";

const KEY = {
  /** Position 1: elevated keep-context approve (auto mode or auto-accept edits). */
  PRIMARY: "1",
  /** Position 2: "manually approve edits" → default mode. */
  MANUAL: "2",
  /** Keep planning / Stop. */
  ESC: "\x1b",
} as const;

export interface BuildPlanKeystrokesArgs {
  decision: PlanDecision;
  /** When true, keep planning (Esc) and ignore `decision`. */
  cancel?: boolean;
}

export interface PlanKeystrokeScript {
  chunks: KeystrokeChunk[];
}

export function buildPlanKeystrokes(args: BuildPlanKeystrokesArgs): PlanKeystrokeScript {
  if (args.cancel) return { chunks: [{ bytes: KEY.ESC }] };
  switch (args.decision) {
    case "approve-primary":
      return { chunks: [{ bytes: KEY.PRIMARY }] };
    case "approve-manual":
      return { chunks: [{ bytes: KEY.MANUAL }] };
  }
}
