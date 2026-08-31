import { reconcileModelAlias } from "common/model";
import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";
import { isEffortLevel } from "common/types";

/**
 * What the transcript last said the session is *actually* running, and the rules
 * for correcting the stored alias/effort to match.
 *
 * Split out of `Session` because the interesting part is a **sequencing** rule,
 * not a calculation. Reconciliation is suppressed while a pending pick is
 * unapplied or a respawn is in flight — but suppression must defer the
 * observation, never discard it. `TranscriptWatcher` dedupes on the model id and
 * effort level, so a value dropped while suppressed is never reported again, and
 * the correction is lost for the life of the session. Holding the observation
 * here is what makes it replayable, and keeping the type free of I/O is what
 * makes the rule testable without spawning a CLI.
 */
export class RuntimeReconciler {
  private modelId: string | null = null;
  private effortLevel: string | null = null;

  /** Latest model id seen in the transcript, or null if none/invalidated. */
  get observedModelId(): string | null {
    return this.modelId;
  }

  /** Latest effort level seen in the transcript, or null if none/invalidated. */
  get observedEffort(): string | null {
    return this.effortLevel;
  }

  /** Retain a model id. Returns false if it repeats the one already held. */
  observeModel(modelId: string): boolean {
    if (this.modelId === modelId) return false;
    this.modelId = modelId;
    return true;
  }

  /** Retain an effort level. Returns false if it repeats the one already held. */
  observeEffort(effort: string): boolean {
    if (this.effortLevel === effort) return false;
    this.effortLevel = effort;
    return true;
  }

  /**
   * Forget both observations, because the process they describe is gone.
   *
   * Called when the PTY is replaced. Replaying them against the *new* intent
   * would revert it: respawning to `opus` while the retained id still reads
   * `claude-sonnet-5` makes {@link reconcileModelAlias} "correct" the alias
   * straight back to `sonnet`. The resumed session reports its own model and
   * effort on its first turn, so there is nothing to preserve here.
   */
  invalidate(): void {
    this.modelId = null;
    this.effortLevel = null;
  }

  /**
   * The alias correction implied by the retained model id, or null to keep the
   * stored one. `suppressed` blocks the correction but not the retention — that
   * asymmetry is the whole reason this state lives here.
   *
   * Family-level only, and deliberately so: the model id carries the family but
   * not the 1M marker, so a same-family alias (including `opus[1m]`) is
   * preserved and only a true family mismatch is corrected. `opusplan` and
   * `haiku` are preserved too, since their dual-model resolutions are valid
   * rather than mismatched.
   */
  reconcileModel(intent: {
    model: ClaudeModel;
    permissionMode: PermissionMode;
    suppressed: boolean;
  }): ClaudeModel | null {
    if (intent.suppressed || this.modelId === null) return null;
    const corrected = reconcileModelAlias(intent.model, intent.permissionMode, {
      modelId: this.modelId,
    });
    return corrected && corrected !== intent.model ? corrected : null;
  }

  /**
   * The effort correction implied by the retained level, or null to keep the
   * stored one.
   *
   * `auto` is preserved, never corrected: it means "no override, use the model
   * default", so a concrete observed level is auto's *resolution* rather than a
   * mismatch — the same reason {@link reconcileModelAlias} preserves `opusplan`.
   * Levels Claude Code accepts but we don't model (e.g. `ultracode`) are ignored
   * rather than coerced, because a wrong badge is worse than a stale one.
   */
  reconcileEffort(intent: {
    effort: EffortLevel | undefined;
    suppressed: boolean;
  }): EffortLevel | null {
    if (intent.suppressed || this.effortLevel === null) return null;
    if (intent.effort === undefined || intent.effort === "auto") return null;
    if (!isEffortLevel(this.effortLevel)) return null;
    return this.effortLevel === intent.effort ? null : this.effortLevel;
  }
}

/** The controller-side pick that has not been applied to the running PTY yet. */
export interface PendingPick {
  model: ClaudeModel | null;
  effort: EffortLevel | null;
}

/**
 * The pending overlay produced by a new model/effort pick.
 *
 * A pick equal to the running value is **not** pending, which is how the overlay
 * can clear without a respawn — the user picking X, then changing their mind
 * back to what is already running. That path is the one that strands a deferred
 * observation, so it is reported separately as `cleared` rather than being
 * folded into `changed`.
 *
 * An omitted `effort` means "this pick says nothing about effort", which drops
 * any pending effort rather than preserving it. Callers that want to keep one
 * must pass it through; the UI always sends both.
 */
export function nextPendingPick(
  current: { model: ClaudeModel; effort: EffortLevel | undefined },
  pending: PendingPick,
  pick: { model: ClaudeModel; effort?: EffortLevel },
): { next: PendingPick; changed: boolean; cleared: boolean } {
  const model = pick.model === current.model ? null : pick.model;
  const effort = pick.effort === undefined || pick.effort === current.effort ? null : pick.effort;
  return {
    next: { model, effort },
    changed: model !== pending.model || effort !== pending.effort,
    cleared:
      (pending.model !== null && model === null) || (pending.effort !== null && effort === null),
  };
}
