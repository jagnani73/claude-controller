import {
  displayNameMatchesIntent,
  formatModelName,
  modelFamily,
  type ParsedModelId,
  parseModelId,
} from "common/model";
import { autoCycleSupport } from "common/permission-cycle";
import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";
import { isKnownClaudeModel } from "common/types";

/**
 * Canonical model aliases — mirrors Claude Code's MODEL_ALIASES list, minus
 * `best` (loads opus by default — no UI distinction worth surfacing).
 *
 * The labels are alias names (the user's pick), not claims about which model
 * version an alias resolves to — that moves with each release. Use
 * {@link modelOptionsWithHints} to add the version once one has been observed.
 */
export const MODEL_OPTIONS: { value: ClaudeModel; label: string; hint?: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "opus[1m]", label: "Opus · 1M", hint: "1M context" },
  { value: "opusplan", label: "Opus Plan", hint: "opus in plan, sonnet otherwise" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet · 1M", hint: "1M context" },
  { value: "haiku", label: "Haiku" },
];

/**
 * Picker label for any model: the seed label, a full id's own name ("Fable
 * 5.2"), or a learned alias capitalised ("Fable", "Fable · 1M"). A label, not
 * a claim about what is running.
 */
export function modelLabel(model: ClaudeModel): string {
  const seed = MODEL_OPTIONS.find((o) => o.value === model);
  if (seed) return seed.label;
  const id = formatModelName(model);
  if (id) return id;
  const bare = model.replace(/\[1m\]$/, "");
  const word = bare.charAt(0).toUpperCase() + bare.slice(1);
  return bare === model ? word : `${word} · 1M`;
}

/**
 * {@link MODEL_OPTIONS} plus each of `extra` (learned aliases, the session's
 * current value) not already listed, with a version hint ("<Family> <version>")
 * on each alias whose family has been observed running, taken from `latest`
 * (see `latestModelByFamily`). Families never observed get no hint — a version
 * is never invented. `opusplan` spans two families, and a full model id already
 * names its version, so neither gets one.
 */
export function modelOptionsWithHints(
  latest: ReadonlyMap<string, ParsedModelId>,
  extra: Iterable<ClaudeModel> = [],
) {
  const options: { value: ClaudeModel; label: string; hint?: string }[] = [...MODEL_OPTIONS];
  for (const model of extra) {
    if (options.some((o) => o.value === model)) continue;
    options.push({
      value: model,
      label: modelLabel(model),
      hint: model.endsWith("[1m]") ? "1M context" : undefined,
    });
  }
  return options.map((opt) => {
    const family = parseModelId(opt.value) ? null : modelFamily(opt.value);
    const observed = family ? latest.get(family)?.name : undefined;
    if (!observed) return opt;
    return { ...opt, hint: opt.hint ? `${observed} · ${opt.hint}` : observed };
  });
}

/** Bare opus aliases (excludes opusplan, which has dual-model semantics). */
export function isPlainOpus(model: ClaudeModel): boolean {
  return model === "opus" || model === "opus[1m]";
}

/** `/effort` is rejected by haiku; everything else accepts low/medium/high. */
export function supportsEffort(model: ClaudeModel): boolean {
  return model !== "haiku";
}

/**
 * `xhigh` is only offered on the plain opus aliases — among the verified ones.
 * A model outside the seed list has unknown tiers, so every level is offered and
 * the transcript's effort reconciliation corrects the badge if the CLI resolves
 * a lower one.
 */
export function supportsXHighEffort(model: ClaudeModel): boolean {
  return isPlainOpus(model) || !isKnownClaudeModel(model);
}

/** `max` is supported on opus/sonnet families (incl. opusplan); haiku rejects it. */
export function supportsMaxEffort(model: ClaudeModel): boolean {
  return model !== "haiku";
}

/**
 * Auto permission mode gate. Delegates to the shared `autoCycleSupport` so
 * the frontend (enable/disable the option + clamp on model switch) and the
 * backend (PTY Shift+Tab keystroke math) share one source of truth. Currently
 * every verified model but haiku — see `cycleCanIncludeAuto` for how it was
 * established. An unverified model is not offered auto.
 */
export function supportsAutoMode(model: ClaudeModel): boolean {
  return autoCycleSupport(model) === true;
}

/**
 * Whether the running session's mode can be changed from here. Live changes
 * walk the Shift+Tab cycle, which is only predictable for a verified model; the
 * backend refuses the rest. (Spawn-time `--permission-mode` needs no prediction.)
 */
export function supportsLiveModeSwitch(model: ClaudeModel): boolean {
  return autoCycleSupport(model) !== null;
}

export function effortOptionsFor(
  model: ClaudeModel,
): { value: EffortLevel; label: string; hint?: string; disabled?: boolean }[] {
  const effortDisabled = !supportsEffort(model);
  const xhighDisabled = !supportsXHighEffort(model);
  const maxDisabled = !supportsMaxEffort(model);
  return [
    // `auto` clears the override — Claude Code falls back to the model default.
    { value: "auto", label: "Auto", hint: "model default" },
    { value: "low", label: "Low", disabled: effortDisabled },
    { value: "medium", label: "Medium", disabled: effortDisabled },
    { value: "high", label: "High", disabled: effortDisabled },
    {
      value: "xhigh",
      label: "XHigh",
      hint: xhighDisabled ? "opus only" : undefined,
      disabled: xhighDisabled,
    },
    {
      value: "max",
      label: "Max",
      disabled: maxDisabled,
    },
  ];
}

/**
 * Snap `effort` down to the highest tier the new model supports. Order is
 * low < medium < high < xhigh < max for the "downgrade to nearest" pick.
 */
export function clampEffort(model: ClaudeModel, effort: EffortLevel | undefined): EffortLevel {
  if (!effort || effort === "auto") return "auto";
  if (!supportsEffort(model)) return "auto";
  if (effort === "xhigh" && !supportsXHighEffort(model)) {
    return supportsMaxEffort(model) ? "max" : "high";
  }
  if (effort === "max" && !supportsMaxEffort(model)) return "high";
  return effort;
}

/** Drop `auto` permission mode when switching to a model that doesn't allow it. */
export function clampPermissionMode(model: ClaudeModel, mode: PermissionMode): PermissionMode {
  if (mode === "auto" && !supportsAutoMode(model)) return "default";
  return mode;
}

/** What the running session has told us about its model. Both parts are optional. */
export interface ObservedRuntime {
  /** Model id observed in the transcript (`SessionInfo.currentModelId`). */
  modelId?: string;
  /** Claude Code's `model.display_name`; only present with a statusline command. */
  displayName?: string;
}

/**
 * Name of the model actually running, or null when it isn't known.
 *
 * Preferred source is the transcript model id, formatted structurally by
 * `formatModelName` (the id has no 1M marker, so "(1M)" comes from the alias).
 * Otherwise Claude Code's statusline `display_name`. Either is used only when it
 * matches the *expected* runtime for `(model, permissionMode)` — otherwise we're
 * in the gap between a settings change and the next respawn / turn, where the
 * runtime is still the previous model and would mislead the user.
 */
function runtimeModelName(
  model: ClaudeModel,
  permissionMode: PermissionMode,
  runtime: ObservedRuntime,
): string | null {
  const { modelId, displayName } = runtime;
  if (modelId && displayNameMatchesIntent(model, permissionMode, undefined, modelId)) {
    const name = formatModelName(modelId);
    if (name) return model.endsWith("[1m]") ? `${name} (1M)` : name;
  }
  if (displayName && displayNameMatchesIntent(model, permissionMode, displayName)) {
    return displayName;
  }
  return null;
}

/**
 * The label to render for the model badge, or null to render nothing.
 *
 * Shows the name of the model actually running (see `runtimeModelName`), with
 * the active sub-model after the alias when it resolves to different runtime
 * models depending on permission mode (opusplan, haiku-in-plan).
 *
 * When that name isn't known the badge is hidden: a version is never guessed.
 * The one exception is a `pending` pick, which shows the alias label — that is
 * the user's choice ("will switch to X"), not a claim about what is running.
 */
export function displayedModelLabel(
  model: ClaudeModel,
  permissionMode: PermissionMode,
  runtime: ObservedRuntime,
  pending = false,
): string | null {
  const name = runtimeModelName(model, permissionMode, runtime);
  const aliasLabel = modelLabel(model);
  if (!name) return pending ? aliasLabel : null;

  if (model === "opusplan") return `${aliasLabel} · ${name}`;
  if (model === "haiku" && permissionMode === "plan") return `${aliasLabel} · ${name}`;
  return name;
}
