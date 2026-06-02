import type { ClaudeModel, PermissionMode } from "./types/index.js";

/**
 * Whether the runtime model (Claude Code's `model.display_name`, e.g.
 * "Opus 4.7 (1M context)", and/or the transcript model id, e.g.
 * "claude-opus-4-7") is a valid resolution of the user-selected `model` alias
 * for the given permission mode.
 *
 * Encodes the dual-model aliases:
 *  - `opusplan` resolves to Opus in plan mode, Sonnet otherwise.
 *  - `haiku` resolves to Sonnet in plan mode, Haiku otherwise.
 *
 * Used by the frontend label (only show the runtime name when it matches the
 * intent) AND the backend reconciliation (a *non*-match means the alias is
 * stale). Couples to Claude Code's display-name format; if that changes these
 * checks silently stop matching and callers fall back to the alias label.
 *
 * NB: family-level only — it does not distinguish the 1M variant (the display
 * name carries "(1M context)", which `inferAliasFromRuntime` reads instead).
 */
export function displayNameMatchesIntent(
  model: ClaudeModel,
  permissionMode: PermissionMode,
  displayName?: string,
  modelId?: string,
): boolean {
  const dn = (displayName ?? "").toLowerCase();
  const id = (modelId ?? "").toLowerCase();
  const has = (re: RegExp): boolean => re.test(dn) || re.test(id);
  // "plan" only ever appears in the display name, never the model id.
  const isPlanName = /\bplan\b/.test(dn);
  switch (model) {
    case "opus":
    case "opus[1m]":
      return has(/opus/) && !isPlanName;
    case "sonnet":
    case "sonnet[1m]":
      return has(/sonnet/);
    case "opusplan":
      return permissionMode === "plan" ? has(/opus/) : has(/sonnet/);
    case "haiku":
      return permissionMode === "plan" ? has(/sonnet/) : has(/haiku/);
  }
}

/**
 * Best-effort map from the observed runtime back to a `ClaudeModel` alias.
 * Family comes from the display name or model id; the 1M variant comes ONLY
 * from the display name's "(1M context)" marker (the model id can't express
 * it). Returns null when the family can't be determined — never guess.
 */
export function inferAliasFromRuntime(displayName?: string, modelId?: string): ClaudeModel | null {
  const dn = (displayName ?? "").toLowerCase();
  const id = (modelId ?? "").toLowerCase();
  const has = (re: RegExp): boolean => re.test(dn) || re.test(id);
  const is1m = /\(1m context\)/i.test(displayName ?? "");
  if (has(/opus/)) return is1m ? "opus[1m]" : "opus";
  if (has(/sonnet/)) return is1m ? "sonnet[1m]" : "sonnet";
  if (has(/haiku/)) return "haiku"; // no haiku[1m] alias exists
  return null;
}

/**
 * Given the stored alias, the permission mode, and the observed runtime, return
 * a corrected alias when the stored one is provably wrong, else null (keep it).
 *
 * - Preserves `opusplan`/`haiku`: `displayNameMatchesIntent` treats their valid
 *   sub-model resolutions as a match, so they're never rewritten.
 * - Fixes family mismatches (the "shows Sonnet while running Opus" bug),
 *   including from a model-id-only signal (transcript) before the statusline.
 * - Fixes 1M-ness only when the display name is present (the reliable 1M
 *   signal); a model-id-only read never flips a same-family alias.
 */
export function reconcileModelAlias(
  alias: ClaudeModel,
  permissionMode: PermissionMode,
  runtime: { displayName?: string; modelId?: string },
): ClaudeModel | null {
  const inferred = inferAliasFromRuntime(runtime.displayName, runtime.modelId);
  if (!inferred || inferred === alias) return null;
  if (displayNameMatchesIntent(alias, permissionMode, runtime.displayName, runtime.modelId)) {
    // Family matches the alias's expected runtime. Dual-model aliases keep
    // theirs; a plain alias only differs on 1M-ness, which we correct only with
    // the display name (the 1M signal), never from a model id alone.
    if (alias === "opusplan" || alias === "haiku") return null;
    return runtime.displayName ? inferred : null;
  }
  // Genuine mismatch — the alias's family can't produce this runtime.
  return inferred;
}
