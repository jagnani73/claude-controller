import { displayNameMatchesIntent } from "common/model";
import { cycleCanIncludeAuto } from "common/permission-cycle";
import type { ClaudeModel, EffortLevel, PermissionMode } from "common/types";

/**
 * Canonical model aliases — mirrors Claude Code's MODEL_ALIASES list, minus
 * `best` (loads opus by default — no UI distinction worth surfacing).
 */
export const MODEL_OPTIONS: { value: ClaudeModel; label: string; hint?: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "opus[1m]", label: "Opus · 1M", hint: "1M context" },
  { value: "opusplan", label: "Opus Plan", hint: "opus in plan, sonnet otherwise" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet · 1M", hint: "1M context" },
  { value: "haiku", label: "Haiku" },
];

/** Bare opus aliases (excludes opusplan, which has dual-model semantics). */
export function isPlainOpus(model: ClaudeModel): boolean {
  return model === "opus" || model === "opus[1m]";
}

/** `/effort` is rejected by haiku; everything else accepts low/medium/high. */
export function supportsEffort(model: ClaudeModel): boolean {
  return model !== "haiku";
}

/** `xhigh` is new in Opus 4.7 — only the plain opus aliases. */
export function supportsXHighEffort(model: ClaudeModel): boolean {
  return isPlainOpus(model);
}

/** `max` is supported on opus/sonnet families (incl. opusplan); haiku rejects it. */
export function supportsMaxEffort(model: ClaudeModel): boolean {
  return model !== "haiku";
}

/**
 * Auto permission mode gate. Delegates to the shared `cycleCanIncludeAuto` so
 * the frontend (enable/disable the option + clamp on model switch) and the
 * backend (PTY Shift+Tab keystroke math) share one source of truth. Currently
 * every model but haiku — see that function for how it was established.
 */
export function supportsAutoMode(model: ClaudeModel): boolean {
  return cycleCanIncludeAuto(model);
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

/**
 * The label to render for the user-set alias, with the active sub-model in
 * parens when the alias resolves to different runtime models depending on
 * permission mode (opusplan, haiku-in-plan).
 *
 * `displayName` (Claude Code's `model.display_name`, e.g. "Opus 4.7", "Sonnet
 * 4.6 (1M context)") is the runtime model's name. It only gets used when it
 * matches the *expected* runtime for `(model, permissionMode)` — otherwise
 * we're in the gap between a popover change and the next respawn, where the
 * runtime is still the previous PTY's model and would mislead the user.
 */
export function displayedModelLabel(
  model: ClaudeModel,
  permissionMode: PermissionMode,
  displayName?: string,
): string {
  const fallback = MODEL_OPTIONS.find((o) => o.value === model)?.label ?? model;
  const dn =
    displayName && displayNameMatchesIntent(model, permissionMode, displayName)
      ? displayName
      : undefined;

  if (model === "opusplan") {
    // In plan mode opusplan resolves to opus; otherwise to sonnet.
    return permissionMode === "plan"
      ? `Opus Plan · ${dn ?? "Opus"}`
      : `Opus Plan · ${dn ?? "Sonnet"}`;
  }
  if (model === "haiku" && permissionMode === "plan") {
    return `Haiku · ${dn ?? "Sonnet"}`;
  }
  return dn ?? fallback;
}
