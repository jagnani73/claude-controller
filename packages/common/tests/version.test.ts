import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_TARGET_VERSION,
  classifyCliVersion,
  compareVersions,
  isBelowMinimumVersion,
} from "../src/version";

describe("compareVersions", () => {
  it("compares segments numerically, not lexically", () => {
    // The case a string compare gets wrong: "2.1.9" > "2.1.10" lexically.
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("2.1.87", "2.1.251")).toBe(-1);
    expect(compareVersions("2.1.251", "2.1.87")).toBe(1);
  });

  it("treats missing trailing segments as zero", () => {
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("2.1.0.0", "2.1")).toBe(0);
    expect(compareVersions("2.1", "2.1.1")).toBe(-1);
  });

  it("orders across major and minor", () => {
    expect(compareVersions("2.2.0", "2.1.251")).toBe(1);
    expect(compareVersions("3.0.0", "2.9.9")).toBe(1);
  });

  it("returns 0 for equal versions", () => {
    expect(compareVersions("2.1.251", "2.1.251")).toBe(0);
  });

  it("treats a pre-release suffix as its numeric prefix", () => {
    // Documenting current behaviour, not endorsing it: parseInt("251-beta") is
    // 251, so a pre-release compares equal to the release and classifies as
    // "match". Acceptable while Claude Code ships plain x.y.z — if it ever
    // publishes suffixed builds this needs revisiting, and this test will be
    // the thing that flags the assumption.
    expect(compareVersions("2.1.251-beta", "2.1.251")).toBe(0);
    expect(classifyCliVersion("2.1.251-beta", "2.1.251")).toBe("match");
  });

  it("degrades to zero on unparseable segments rather than throwing", () => {
    // Version strings come from the CLI, so a surprise must not crash the
    // session — it should just sort low.
    expect(compareVersions("", "2.1.251")).toBe(-1);
    expect(compareVersions("2.x.1", "2.0.1")).toBe(0);
  });
});

describe("classifyCliVersion", () => {
  it("classifies against the target", () => {
    expect(classifyCliVersion(CLAUDE_CODE_TARGET_VERSION)).toBe("match");
    expect(classifyCliVersion("2.1.220")).toBe("older");
    expect(classifyCliVersion("9.9.9")).toBe("newer");
  });

  it("accepts an explicit target", () => {
    expect(classifyCliVersion("2.1.5", "2.1.5")).toBe("match");
    expect(classifyCliVersion("2.1.4", "2.1.5")).toBe("older");
  });
});

describe("isBelowMinimumVersion", () => {
  it("is exclusive at the boundary", () => {
    expect(isBelowMinimumVersion(CLAUDE_CODE_MINIMUM_VERSION)).toBe(false);
    expect(isBelowMinimumVersion("2.1.234")).toBe(true);
    expect(isBelowMinimumVersion("2.1.235")).toBe(false);
  });

  it("flags the builds whose AskUserQuestion fixes we depend on", () => {
    // < 2.1.144: Esc in the notes field aborted the turn.
    // < 2.1.181: multi-select dropped a typed "Other" answer.
    // < 2.1.235: arrow-then-Enter in quick succession committed the previously
    //   highlighted option — which is every non-default answer the relay makes.
    expect(isBelowMinimumVersion("2.1.87")).toBe(true);
    expect(isBelowMinimumVersion("2.1.143")).toBe(true);
    expect(isBelowMinimumVersion("2.1.144")).toBe(true);
    expect(isBelowMinimumVersion("2.1.181")).toBe(true);
  });
});

describe("version constants", () => {
  it("keeps the target at or above the hard minimum", () => {
    // The relays produce wrong answers below the minimum, so a target under it
    // would be incoherent.
    expect(
      compareVersions(CLAUDE_CODE_TARGET_VERSION, CLAUDE_CODE_MINIMUM_VERSION),
    ).toBeGreaterThanOrEqual(0);
  });
});
