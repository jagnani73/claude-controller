import type { ClaudeModel, EffortLevel } from "common/types";

/**
 * Canonical model aliases — mirrors Claude Code's MODEL_ALIASES list.
 * Grouping is purely cosmetic for the picker.
 */
export const MODEL_OPTIONS: { value: ClaudeModel; label: string; hint?: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "opus[1m]", label: "Opus · 1M", hint: "1M context" },
  { value: "opusplan", label: "Opus Plan", hint: "Opus + plan" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet · 1M", hint: "1M context" },
  { value: "haiku", label: "Haiku" },
];

/** Any Opus-family alias (plain, 1M, or opusplan). */
export function isOpusFamily(model: ClaudeModel): boolean {
  return model === "opus" || model === "opus[1m]" || model === "opusplan";
}

/**
 * `/effort` is accepted by Claude 4.6 opus/sonnet; haiku and legacy variants
 * reject it (see `claude-code-source/src/utils/effort.ts:modelSupportsEffort`).
 */
export function supportsEffort(model: ClaudeModel): boolean {
  return model !== "haiku";
}

/**
 * `max` effort is Opus-4.6 only. Disable it for everything else.
 */
export function supportsMaxEffort(model: ClaudeModel): boolean {
  return isOpusFamily(model);
}

export function effortOptionsFor(
  model: ClaudeModel,
): { value: EffortLevel; label: string; hint?: string; disabled?: boolean }[] {
  const effortDisabled = !supportsEffort(model);
  const maxDisabled = !supportsMaxEffort(model);
  return [
    { value: "low", label: "Low", disabled: effortDisabled },
    { value: "medium", label: "Medium", disabled: effortDisabled },
    { value: "high", label: "High", disabled: effortDisabled },
    {
      value: "max",
      label: "Max",
      hint: maxDisabled ? "opus only" : undefined,
      disabled: maxDisabled,
    },
  ];
}

/** Clamp an effort to one the given model supports. */
export function clampEffort(model: ClaudeModel, effort: EffortLevel): EffortLevel {
  if (!supportsEffort(model)) return "medium";
  if (effort === "max" && !supportsMaxEffort(model)) return "high";
  return effort;
}
