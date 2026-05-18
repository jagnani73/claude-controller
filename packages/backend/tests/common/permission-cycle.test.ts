import { describe, expect, it } from "bun:test";
import { cycleCanIncludeAuto, cycleDistance, nextPermissionMode } from "common/permission-cycle";

describe("cycleCanIncludeAuto", () => {
  it("returns true only for plain opus aliases", () => {
    expect(cycleCanIncludeAuto("opus")).toBe(true);
    expect(cycleCanIncludeAuto("opus[1m]")).toBe(true);
  });

  it("returns false for opusplan, sonnet variants, and haiku", () => {
    expect(cycleCanIncludeAuto("opusplan")).toBe(false);
    expect(cycleCanIncludeAuto("sonnet")).toBe(false);
    expect(cycleCanIncludeAuto("sonnet[1m]")).toBe(false);
    expect(cycleCanIncludeAuto("haiku")).toBe(false);
  });
});

describe("nextPermissionMode", () => {
  describe("with auto available (4-step cycle)", () => {
    const opts = { autoAvailable: true };

    it("walks default → acceptEdits → plan → auto → default", () => {
      expect(nextPermissionMode("default", opts)).toBe("acceptEdits");
      expect(nextPermissionMode("acceptEdits", opts)).toBe("plan");
      expect(nextPermissionMode("plan", opts)).toBe("auto");
      expect(nextPermissionMode("auto", opts)).toBe("default");
    });
  });

  describe("without auto (3-step cycle)", () => {
    const opts = { autoAvailable: false };

    it("walks default → acceptEdits → plan → default", () => {
      expect(nextPermissionMode("default", opts)).toBe("acceptEdits");
      expect(nextPermissionMode("acceptEdits", opts)).toBe("plan");
      expect(nextPermissionMode("plan", opts)).toBe("default");
    });

    it("collapses auto back to default if somehow reached", () => {
      expect(nextPermissionMode("auto", opts)).toBe("default");
    });
  });
});

describe("cycleDistance", () => {
  describe("4-step cycle (auto available)", () => {
    const opts = { autoAvailable: true };

    it("returns 0 when from === to", () => {
      expect(cycleDistance("default", "default", opts)).toBe(0);
      expect(cycleDistance("plan", "plan", opts)).toBe(0);
    });

    it("counts forward steps", () => {
      expect(cycleDistance("default", "acceptEdits", opts)).toBe(1);
      expect(cycleDistance("default", "plan", opts)).toBe(2);
      expect(cycleDistance("default", "auto", opts)).toBe(3);
    });

    it("wraps around the full cycle for backward moves", () => {
      expect(cycleDistance("plan", "default", opts)).toBe(2);
      expect(cycleDistance("acceptEdits", "default", opts)).toBe(3);
      expect(cycleDistance("auto", "plan", opts)).toBe(3);
    });
  });

  describe("3-step cycle (auto unavailable)", () => {
    const opts = { autoAvailable: false };

    it("counts forward steps without auto", () => {
      expect(cycleDistance("default", "acceptEdits", opts)).toBe(1);
      expect(cycleDistance("default", "plan", opts)).toBe(2);
    });

    it("wraps around the 3-step cycle", () => {
      expect(cycleDistance("plan", "default", opts)).toBe(1);
      expect(cycleDistance("acceptEdits", "default", opts)).toBe(2);
      expect(cycleDistance("plan", "acceptEdits", opts)).toBe(2);
    });

    it("returns 0 for unreachable target (auto)", () => {
      expect(cycleDistance("default", "auto", opts)).toBe(0);
      expect(cycleDistance("plan", "auto", opts)).toBe(0);
    });
  });
});
