import type { ClaudeModel } from "common/types";
import { describe, expect, it } from "vitest";
import type { PendingPick } from "../src/session/runtime-reconciler";
import { nextPendingPick, RuntimeReconciler } from "../src/session/runtime-reconciler";

/** Reconcile against a plain (non-plan) session unless a test says otherwise. */
const asModel = (r: RuntimeReconciler, model: ClaudeModel, suppressed = false) =>
  r.reconcileModel({ model, permissionMode: "default", suppressed });

describe("RuntimeReconciler — deferring vs discarding", () => {
  it("defers a correction while suppressed, then applies it once suppression lifts", () => {
    // The whole point of the type. TranscriptWatcher dedupes on the model id, so
    // an observation dropped while a pending pick is unapplied never arrives
    // again — the alias would stay wrong for the life of the session.
    const r = new RuntimeReconciler();
    r.observeModel("claude-opus-5");
    expect(asModel(r, "sonnet", true)).toBeNull();
    expect(asModel(r, "sonnet", false)).toBe("opus");
  });

  it("stays replayable even though the transcript reports the id only once", () => {
    const r = new RuntimeReconciler();
    expect(r.observeModel("claude-opus-5")).toBe(true);
    // Second report of the same id is deduped — the retained value, not a repeat
    // callback, is what makes the deferred correction recoverable.
    expect(r.observeModel("claude-opus-5")).toBe(false);
    expect(asModel(r, "sonnet")).toBe("opus");
  });

  it("defers an effort correction the same way", () => {
    const r = new RuntimeReconciler();
    r.observeEffort("high");
    expect(r.reconcileEffort({ effort: "low", suppressed: true })).toBeNull();
    expect(r.reconcileEffort({ effort: "low", suppressed: false })).toBe("high");
  });

  it("has nothing to say before anything has been observed", () => {
    const r = new RuntimeReconciler();
    expect(asModel(r, "sonnet")).toBeNull();
    expect(r.reconcileEffort({ effort: "low", suppressed: false })).toBeNull();
  });
});

describe("RuntimeReconciler.invalidate", () => {
  it("drops observations so a respawn's new intent is not reverted", () => {
    // The trap in the fix: after respawning to opus, the retained id still reads
    // claude-sonnet-5 until the resumed session takes a turn. Replaying it would
    // "correct" the alias straight back to sonnet and undo the user's switch.
    const r = new RuntimeReconciler();
    r.observeModel("claude-sonnet-5");
    r.observeEffort("low");
    expect(asModel(r, "opus")).toBe("sonnet");

    r.invalidate();
    expect(asModel(r, "opus")).toBeNull();
    expect(r.reconcileEffort({ effort: "high", suppressed: false })).toBeNull();
    expect(r.observedModelId).toBeNull();
    expect(r.observedEffort).toBeNull();
  });

  it("lets the same id register again afterwards", () => {
    const r = new RuntimeReconciler();
    r.observeModel("claude-opus-5");
    r.invalidate();
    expect(r.observeModel("claude-opus-5")).toBe(true);
  });
});

describe("RuntimeReconciler.reconcileModel", () => {
  it("corrects a genuine family mismatch", () => {
    const r = new RuntimeReconciler();
    r.observeModel("claude-opus-5");
    expect(asModel(r, "sonnet")).toBe("opus");
  });

  it("keeps a same-family alias, including the 1M variant", () => {
    // The model id carries the family but not the 1M marker, so correcting from
    // it alone would silently downgrade opus[1m] to opus.
    const r = new RuntimeReconciler();
    r.observeModel("claude-opus-5");
    expect(asModel(r, "opus")).toBeNull();
    expect(asModel(r, "opus[1m]")).toBeNull();
  });

  it("keeps dual-model aliases, whose sub-model is a valid resolution", () => {
    const r = new RuntimeReconciler();
    r.observeModel("claude-sonnet-5");
    expect(asModel(r, "opusplan")).toBeNull();
    expect(
      r.reconcileModel({ model: "haiku", permissionMode: "plan", suppressed: false }),
    ).toBeNull();
  });
});

describe("RuntimeReconciler.reconcileEffort", () => {
  it("preserves `auto`, which the observed level is a resolution of, not a mismatch", () => {
    const r = new RuntimeReconciler();
    r.observeEffort("high");
    expect(r.reconcileEffort({ effort: "auto", suppressed: false })).toBeNull();
  });

  it("says nothing when no effort is stored", () => {
    const r = new RuntimeReconciler();
    r.observeEffort("high");
    expect(r.reconcileEffort({ effort: undefined, suppressed: false })).toBeNull();
  });

  it("ignores levels Claude Code accepts but we do not model", () => {
    // `ultracode` is real upstream. A stale badge beats a wrong one.
    const r = new RuntimeReconciler();
    r.observeEffort("ultracode");
    expect(r.reconcileEffort({ effort: "high", suppressed: false })).toBeNull();
  });

  it("is a no-op when the stored level already matches", () => {
    const r = new RuntimeReconciler();
    r.observeEffort("high");
    expect(r.reconcileEffort({ effort: "high", suppressed: false })).toBeNull();
  });
});

describe("nextPendingPick", () => {
  const current = { model: "sonnet", effort: "low" } as const;
  const none = { model: null, effort: null };

  it("records a pick that differs from what is running", () => {
    const r = nextPendingPick(current, none, { model: "opus", effort: "high" });
    expect(r.next).toEqual({ model: "opus", effort: "high" });
    expect(r.changed).toBe(true);
    expect(r.cleared).toBe(false);
  });

  it("reports the collapse when the user picks back what is already running", () => {
    // The path that lifts suppression without replacing the PTY, and therefore
    // the one that strands a deferred observation.
    const r = nextPendingPick(current, { model: "opus", effort: null }, { model: "sonnet" });
    expect(r.next).toEqual({ model: null, effort: null });
    expect(r.changed).toBe(true);
    expect(r.cleared).toBe(true);
  });

  it("reports a collapse of the effort overlay too", () => {
    const r = nextPendingPick(
      current,
      { model: null, effort: "high" },
      {
        model: "sonnet",
        effort: "low",
      },
    );
    expect(r.cleared).toBe(true);
  });

  it("is unchanged when the pick repeats the pending one", () => {
    const r = nextPendingPick(current, { model: "opus", effort: null }, { model: "opus" });
    expect(r.changed).toBe(false);
  });

  it("does not claim a collapse when nothing was pending", () => {
    // Guards the flush from running on every no-op pick.
    const r = nextPendingPick(current, none, { model: "sonnet" });
    expect(r.cleared).toBe(false);
  });
});

describe("the change-your-mind sequence", () => {
  it("keeps the alias correct after a pending pick is reverted", () => {
    // End-to-end shape of the bug, in the order it happens:
    //  1. running sonnet, phone picks opus       -> pending
    //  2. an out-of-band /model lands on opus    -> observed, correction deferred
    //  3. phone changes its mind back to sonnet  -> overlay clears, no respawn
    // Before the fix the correction was dropped at (2) and never replayed, so
    // currentModel stayed "sonnet" and the next respawn forced the session off
    // Opus with `--model sonnet`.
    const r = new RuntimeReconciler();
    let model: ClaudeModel = "sonnet";
    let pending: PendingPick = { model: null, effort: null };

    const pick = nextPendingPick({ model, effort: "low" }, pending, { model: "opus" });
    pending = pick.next;
    expect(pending.model).toBe("opus");

    r.observeModel("claude-opus-5");
    expect(r.reconcileModel({ model, permissionMode: "default", suppressed: true })).toBeNull();

    const revert = nextPendingPick({ model, effort: "low" }, pending, { model: "sonnet" });
    pending = revert.next;
    expect(revert.cleared).toBe(true);

    const corrected = r.reconcileModel({
      model,
      permissionMode: "default",
      suppressed: pending.model !== null,
    });
    expect(corrected).toBe("opus");
    model = corrected ?? model;
    expect(model).toBe("opus");
  });
});
