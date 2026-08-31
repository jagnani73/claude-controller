import { describe, expect, it } from "vitest";
import { CLAUDE_MODELS, EFFORT_LEVELS, isClaudeModel, isEffortLevel } from "../src/types/index";

describe("isEffortLevel", () => {
  it("accepts every modelled level", () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true);
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
