import type { ClaudeModel, PermissionMode } from "./types/index.js";

/**
 * Claude Code's Shift+Tab cycle is dynamic. The base path is
 * `default → acceptEdits → plan → default`. When auto mode is reachable
 * for the session, `plan → auto → default` extends it by one stop.
 *
 * See `claude-code-source/src/utils/permissions/getNextPermissionMode.ts`.
 * Both the frontend (for optimistic UI updates) and the backend (for
 * predicting how many Shift+Tab keystrokes to write into the PTY) need
 * the same model — this is that single source of truth.
 */

/**
 * Whether auto mode participates in the cycle for a given model alias.
 * Mirrors Claude Code's runtime gate (`canCycleToAuto`), which today
 * requires the auto-mode availability flag — only granted to plain opus
 * in this codebase. When upstream broadens the gate (Sonnet, Max plan
 * tier, classifier rollout), update this predicate and both consumers
 * track automatically.
 */
export function cycleCanIncludeAuto(model: ClaudeModel): boolean {
  return model === "opus" || model === "opus[1m]";
}

/** The next mode Claude Code transitions to on a single Shift+Tab. */
export function nextPermissionMode(
  current: PermissionMode,
  opts: { autoAvailable: boolean },
): PermissionMode {
  switch (current) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
      return opts.autoAvailable ? "auto" : "default";
    case "auto":
      return "default";
  }
}

/**
 * How many Shift+Tabs to fire to walk from `from` to `to`. Cycle wraps,
 * so the result is always non-negative. `from === to` returns 0.
 */
export function cycleDistance(
  from: PermissionMode,
  to: PermissionMode,
  opts: { autoAvailable: boolean },
): number {
  if (from === to) return 0;
  let cur = from;
  for (let steps = 1; steps <= 4; steps++) {
    cur = nextPermissionMode(cur, opts);
    if (cur === to) return steps;
  }
  // Target unreachable from `from` under the current gate (e.g. asking
  // for `auto` on a session where it isn't part of the cycle).
  return 0;
}
