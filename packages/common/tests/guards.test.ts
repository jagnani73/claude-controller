import { describe, expect, it } from "vitest";
import type { ClaudeModel, EffortLevel } from "../src/types/index";
import { CLAUDE_MODELS, EFFORT_LEVELS, isClaudeModel, isEffortLevel } from "../src/types/index";

describe("isEffortLevel", () => {
  it("accepts every modelled level", () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true);
  });

  it("has an entry for every EffortLevel in the union", () => {
    // The loop above is true by construction and cannot fail. This is the
    // assertion with teeth: adding a level to the union without adding it here
    // makes isEffortLevel silently reject a valid level, and the reconciler
    // then ignores a real /effort change rather than applying it.
    const exhaustive: Record<EffortLevel, true> = {
      auto: true,
      low: true,
      medium: true,
      high: true,
      xhigh: true,
      max: true,
    };
    expect([...EFFORT_LEVELS].sort()).toEqual(Object.keys(exhaustive).sort());
  });

  it("rejects levels Claude Code accepts but we deliberately do not model", () => {
    // `ultracode` is real upstream. Coercing it would put a wrong value on the
    // badge; ignoring it leaves a stale one, which is the better failure.
    expect(isEffortLevel("ultracode")).toBe(false);
  });

  it("rejects near-misses rather than normalising them", () => {
    expect(isEffortLevel("HIGH")).toBe(false);
    expect(isEffortLevel(" high")).toBe(false);
    expect(isEffortLevel("")).toBe(false);
  });
});

describe("isClaudeModel", () => {
  it("accepts every modelled alias", () => {
    for (const model of CLAUDE_MODELS) expect(isClaudeModel(model)).toBe(true);
  });

  it("has an entry for every ClaudeModel in the union", () => {
    // As above: the loop is tautological, this is not. A union member missing
    // from the array makes handleModelSwitch reject a valid alias and fall back
    // to family matching, losing the [1m] distinction with no error.
    const exhaustive: Record<ClaudeModel, true> = {
      opus: true,
      "opus[1m]": true,
      opusplan: true,
      sonnet: true,
      "sonnet[1m]": true,
      haiku: true,
    };
    expect([...CLAUDE_MODELS].sort()).toEqual(Object.keys(exhaustive).sort());
  });

  it("accepts the 1M variants, which the resolved id cannot express as an alias", () => {
    expect(isClaudeModel("opus[1m]")).toBe(true);
    expect(isClaudeModel("sonnet[1m]")).toBe(true);
  });

  it("rejects resolved model ids", () => {
    // PostModelSwitch carries both; only `requested_model` is an alias.
    expect(isClaudeModel("claude-opus-5")).toBe(false);
    expect(isClaudeModel("claude-sonnet-5")).toBe(false);
  });

  it("rejects unknown or malformed aliases", () => {
    expect(isClaudeModel("fable")).toBe(false);
    expect(isClaudeModel("OPUS")).toBe(false);
    expect(isClaudeModel("")).toBe(false);
  });
});
