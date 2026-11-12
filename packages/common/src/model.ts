import type { ClaudeModel, PermissionMode } from "./types/index.js";
import { compareVersions } from "./version.js";

/**
 * A model id read structurally, with no table of known models.
 *
 * `family` and `version` are whatever the id says, so a model released after
 * this code was written parses the same way as one released before it.
 */
export interface ParsedModelId {
  /** Lowercase family token from the id, e.g. "opus". */
  family: string;
  /** Dotted version from the id, e.g. "4.7" (from `4-7`) or "5". */
  version: string;
  /** Human-readable name: capitalised family, a space, then the version. */
  name: string;
}

// Current shape: `claude-<family>-<major>[-<minor>]`.
const FAMILY_FIRST_ID = /^claude-([a-z]+)-(\d{1,2}(?:-\d{1,2})*)$/;
// Legacy shape: `claude-<major>[-<minor>]-<family>`.
const VERSION_FIRST_ID = /^claude-(\d{1,2}(?:-\d{1,2})*)-([a-z]+)$/;

/**
 * Parse an Anthropic model id into family + version, or null when it does not
 * have a recognisable structure. Never guesses.
 *
 * Tolerated: surrounding whitespace, letter case, a trailing 8-digit date stamp
 * (`-20251001`), and a trailing `[1m]`-style suffix (ignored; the transcript id
 * does not carry the 1M marker, so it is only ever an alias-side concern).
 * Anything else (no version, a non-numeric version, a prefix such as a cloud
 * provider's) yields null.
 *
 * ```
 * claude-sonnet-5-5           -> Sonnet 5.5
 * claude-opus-4-7             -> Opus 4.7
 * claude-haiku-4-5-20251001   -> Haiku 4.5
 * claude-opus-5               -> Opus 5
 * claude-3-5-sonnet-20241022  -> Sonnet 3.5
 * ```
 */
export function parseModelId(modelId: string | null | undefined): ParsedModelId | null {
  if (!modelId) return null;
  const id = modelId
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
  let family: string;
  let rawVersion: string;
  const current = FAMILY_FIRST_ID.exec(id);
  if (current) {
    family = current[1];
    rawVersion = current[2];
  } else {
    const legacy = VERSION_FIRST_ID.exec(id);
    if (!legacy) return null;
    family = legacy[2];
    rawVersion = legacy[1];
  }
  const version = rawVersion
    .split("-")
    .map((part) => String(Number(part)))
    .join(".");
  return { family, version, name: `${family[0].toUpperCase()}${family.slice(1)} ${version}` };
}

/** Human name for a model id ("Opus 4.7"), or null when it cannot be parsed. */
export function formatModelName(modelId: string | null | undefined): string | null {
  return parseModelId(modelId)?.name ?? null;
}

/**
 * For each family seen in `modelIds`, the highest version observed. Ids that do
 * not parse are skipped, so a family appears only if one of its models was
 * actually observed. Used to hint what an alias currently resolves to without
 * hard-coding any model.
 */
export function latestModelByFamily(
  modelIds: Iterable<string | null | undefined>,
): Map<string, ParsedModelId> {
  const latest = new Map<string, ParsedModelId>();
  for (const modelId of modelIds) {
    const parsed = parseModelId(modelId);
    if (!parsed) continue;
    const best = latest.get(parsed.family);
    if (!best || compareVersions(parsed.version, best.version) > 0) {
      latest.set(parsed.family, parsed);
    }
  }
  return latest;
}

/**
 * Whether the runtime model (Claude Code's `model.display_name`, e.g.
 * "<Family> <version> (1M context)", and/or the transcript model id, e.g.
 * "claude-<family>-<version>") is a valid resolution of the user-selected `model`
 * alias for the given permission mode.
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
