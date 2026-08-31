import { describe, expect, it } from "vitest";
import { displayNameMatchesIntent, inferAliasFromRuntime, reconcileModelAlias } from "../src/model";

/**
 * Model authority in one function. `reconcileModelAlias` decides whether the
 * stored alias is provably wrong given what the session is actually running —
 * and a wrong answer is never just a bad badge: `Session.currentModel` feeds
 * `--model` on the next respawn, so an over-eager correction silently switches
 * the user's model and a missed one silently switches it back.
 *
 * The asymmetry that runs through all of it: the transcript exposes only the
 * resolved id ("claude-opus-5"), which carries the family but *not* the 1M
 * marker. The statusline display name carries both. So an id-only signal may
 * correct a family mismatch and must never touch 1M-ness.
 */
describe("inferAliasFromRuntime", () => {
  it("reads the family from either the display name or the model id", () => {
    expect(inferAliasFromRuntime("Opus 5", undefined)).toBe("opus");
    expect(inferAliasFromRuntime(undefined, "claude-opus-5")).toBe("opus");
    expect(inferAliasFromRuntime(undefined, "claude-sonnet-5")).toBe("sonnet");
    expect(inferAliasFromRuntime(undefined, "claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("takes 1M-ness only from the display name, which is the only source of it", () => {
    expect(inferAliasFromRuntime("Opus 5 (1M context)", "claude-opus-5")).toBe("opus[1m]");
    expect(inferAliasFromRuntime("Sonnet 5 (1M context)", undefined)).toBe("sonnet[1m]");
    // The id cannot express it, so an id-only read must not invent it.
    expect(inferAliasFromRuntime(undefined, "claude-opus-5")).toBe("opus");
  });

  it("has no haiku[1m], because no such alias exists", () => {
    expect(inferAliasFromRuntime("Haiku 4.5 (1M context)", undefined)).toBe("haiku");
  });

  it("returns null rather than guessing when the family is unreadable", () => {
    expect(inferAliasFromRuntime(undefined, undefined)).toBeNull();
    expect(inferAliasFromRuntime("", "")).toBeNull();
    expect(inferAliasFromRuntime("Some Future Model", "claude-something-9")).toBeNull();
  });
});

describe("displayNameMatchesIntent", () => {
  it("accepts a plain alias running its own family", () => {
    expect(displayNameMatchesIntent("opus", "default", "Opus 5")).toBe(true);
    expect(displayNameMatchesIntent("sonnet", "default", undefined, "claude-sonnet-5")).toBe(true);
  });

  it("rejects a plain alias running another family", () => {
    expect(displayNameMatchesIntent("opus", "default", undefined, "claude-sonnet-5")).toBe(false);
    expect(displayNameMatchesIntent("sonnet", "default", "Opus 5")).toBe(false);
  });

  it("resolves opusplan by permission mode: opus in plan, sonnet outside", () => {
    expect(displayNameMatchesIntent("opusplan", "plan", undefined, "claude-opus-5")).toBe(true);
    expect(displayNameMatchesIntent("opusplan", "default", undefined, "claude-sonnet-5")).toBe(
      true,
    );
    expect(displayNameMatchesIntent("opusplan", "plan", undefined, "claude-sonnet-5")).toBe(false);
  });

  it("resolves haiku by permission mode: sonnet in plan, haiku outside", () => {
    expect(displayNameMatchesIntent("haiku", "plan", undefined, "claude-sonnet-5")).toBe(true);
    expect(displayNameMatchesIntent("haiku", "default", undefined, "claude-haiku-4-5")).toBe(true);
    expect(displayNameMatchesIntent("haiku", "default", undefined, "claude-sonnet-5")).toBe(false);
  });

  it("does not let a plain opus alias match Claude Code's plan-mode name", () => {
    // "plan" only ever appears in the display name, never the id.
    expect(displayNameMatchesIntent("opus", "plan", "Opus 5 (plan mode)")).toBe(false);
  });
});

describe("reconcileModelAlias", () => {
  it("corrects a genuine family mismatch from the id alone", () => {
    // The out-of-band `/model` case: badge says Sonnet, session runs Opus.
    expect(reconcileModelAlias("sonnet", "default", { modelId: "claude-opus-5" })).toBe("opus");
    expect(reconcileModelAlias("opus", "default", { modelId: "claude-sonnet-5" })).toBe("sonnet");
  });

  it("keeps a same-family alias, including 1M, on an id-only signal", () => {
    // The id has no 1M marker, so correcting from it would silently downgrade
    // opus[1m] to opus — a real capability change the user never asked for.
    expect(reconcileModelAlias("opus", "default", { modelId: "claude-opus-5" })).toBeNull();
    expect(reconcileModelAlias("opus[1m]", "default", { modelId: "claude-opus-5" })).toBeNull();
    expect(reconcileModelAlias("sonnet[1m]", "default", { modelId: "claude-sonnet-5" })).toBeNull();
  });

  it("corrects 1M-ness only once the display name is present", () => {
    expect(
      reconcileModelAlias("opus", "default", {
        displayName: "Opus 5 (1M context)",
        modelId: "claude-opus-5",
      }),
    ).toBe("opus[1m]");
    expect(
      reconcileModelAlias("opus[1m]", "default", {
        displayName: "Opus 5",
        modelId: "claude-opus-5",
      }),
    ).toBe("opus");
  });

  it("preserves the dual-model aliases, whose sub-models are valid resolutions", () => {
    // opusplan really does run Sonnet outside plan mode; that is not a mismatch,
    // and rewriting it would destroy the alias the user picked.
    expect(reconcileModelAlias("opusplan", "default", { modelId: "claude-sonnet-5" })).toBeNull();
    expect(reconcileModelAlias("opusplan", "plan", { modelId: "claude-opus-5" })).toBeNull();
    expect(reconcileModelAlias("haiku", "plan", { modelId: "claude-sonnet-5" })).toBeNull();
    expect(reconcileModelAlias("haiku", "default", { modelId: "claude-haiku-4-5" })).toBeNull();
  });

  it("still corrects a dual-model alias running a family it can never resolve to", () => {
    // opusplan is opus-or-sonnet; observing haiku means the alias is stale.
    expect(reconcileModelAlias("opusplan", "default", { modelId: "claude-haiku-4-5" })).toBe(
      "haiku",
    );
  });

  it("keeps the stored alias when the runtime is unreadable", () => {
    // Never guess: no signal means no correction.
    expect(reconcileModelAlias("opus", "default", {})).toBeNull();
    expect(reconcileModelAlias("opus", "default", { modelId: "" })).toBeNull();
    expect(reconcileModelAlias("opus", "default", { modelId: "claude-future-9" })).toBeNull();
  });

  it("is a no-op when the inferred alias already equals the stored one", () => {
    expect(
      reconcileModelAlias("opus[1m]", "default", { displayName: "Opus 5 (1M context)" }),
    ).toBeNull();
  });
});
