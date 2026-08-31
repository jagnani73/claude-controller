import { describe, expect, it } from "vitest";
import { cycleCanIncludeAuto, cycleDistance, nextPermissionMode } from "../src/permission-cycle";
import type { ClaudeModel, PermissionMode } from "../src/types/index";
import { CLAUDE_MODELS } from "../src/types/index";

/**
 * The cycle each model actually walks, as observed by
 * `pnpm verify:permission-cycle` against the target CLI build. These are
 * transcribed probe output, not a restatement of the implementation — that is
 * the only way this file can fail when the predicate is wrong.
 */
const OBSERVED_CYCLES: Record<ClaudeModel, PermissionMode[]> = {
  opus: ["acceptEdits", "plan", "auto", "default"],
  "opus[1m]": ["acceptEdits", "plan", "auto", "default"],
  opusplan: ["acceptEdits", "plan", "auto", "default"],
  sonnet: ["acceptEdits", "plan", "auto", "default"],
  "sonnet[1m]": ["acceptEdits", "plan", "auto", "default"],
  haiku: ["acceptEdits", "plan", "default"],
};

describe("cycleCanIncludeAuto", () => {
  it("matches the cycle the CLI was observed to walk", () => {
    for (const model of CLAUDE_MODELS) {
      expect(cycleCanIncludeAuto(model), model).toBe(OBSERVED_CYCLES[model].includes("auto"));
    }
  });

  it("covers every alias in the union", () => {
    expect(Object.keys(OBSERVED_CYCLES).sort()).toEqual([...CLAUDE_MODELS].sort());
  });

  it("excludes haiku, the only model whose cycle drops the auto stop", () => {
    expect(cycleCanIncludeAuto("haiku")).toBe(false);
  });

  it("includes opusplan, which resolves to auto-capable models in both modes", () => {
    // Regression: this returned false on the theory that a dual-model alias was
    // excluded like haiku. The live cycle includes auto, so `cycleDistance` was
    // writing one Shift+Tab too few and landing sessions in the wrong mode.
    expect(cycleCanIncludeAuto("opusplan")).toBe(true);
  });
});

describe("nextPermissionMode", () => {
  it("reproduces each observed cycle from `default`", () => {
    for (const model of CLAUDE_MODELS) {
      const walked: PermissionMode[] = [];
      let cur: PermissionMode = "default";
      for (let i = 0; i < OBSERVED_CYCLES[model].length; i++) {
        cur = nextPermissionMode(cur, { autoAvailable: cycleCanIncludeAuto(model) });
        walked.push(cur);
      }
      expect(walked, model).toEqual(OBSERVED_CYCLES[model]);
    }
  });

  it("returns to the start after a full lap", () => {
    for (const autoAvailable of [true, false]) {
      const laps = autoAvailable ? 4 : 3;
      let cur: PermissionMode = "default";
      for (let i = 0; i < laps; i++) cur = nextPermissionMode(cur, { autoAvailable });
      expect(cur).toBe("default");
    }
  });
});

describe("cycleDistance", () => {
  it("counts the keystrokes that actually land on the target", () => {
    for (const autoAvailable of [true, false]) {
      const modes: PermissionMode[] = autoAvailable
        ? ["default", "acceptEdits", "plan", "auto"]
        : ["default", "acceptEdits", "plan"];
      for (const from of modes) {
        for (const to of modes) {
          const steps = cycleDistance(from, to, { autoAvailable });
          let cur = from;
          for (let i = 0; i < steps; i++) cur = nextPermissionMode(cur, { autoAvailable });
          expect(cur, `${from} -> ${to}`).toBe(to);
        }
      }
    }
  });

  it("is 0 for a no-op", () => {
    expect(cycleDistance("plan", "plan", { autoAvailable: true })).toBe(0);
  });

  it("returns 0 rather than a wrong count when the target is off-cycle", () => {
    // `setPermissionMode` treats 0 as unreachable and refuses. Writing *some*
    // number of Shift+Tabs instead would silently land on another mode.
    for (const from of ["default", "acceptEdits", "plan"] as const) {
      expect(cycleDistance(from, "auto", { autoAvailable: false }), from).toBe(0);
    }
  });

  it("wraps rather than going backwards", () => {
    expect(cycleDistance("plan", "default", { autoAvailable: false })).toBe(1);
    expect(cycleDistance("plan", "default", { autoAvailable: true })).toBe(2);
  });
});
