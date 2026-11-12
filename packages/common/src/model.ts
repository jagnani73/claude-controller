import type { ClaudeModel, PermissionMode } from "./types/index.js";
import { CLAUDE_MODELS, isClaudeModel } from "./types/index.js";
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
 * The one family an alias or model id names, read structurally: a full id's
 * parsed family (`claude-fable-5-2` → `fable`), or a bare alias word with any
 * `[1m]` dropped (`opus[1m]` → `opus`, `fable` → `fable`). Null for `opusplan`,
 * which spans two families, and for anything that names no family.
 *
 * A bare word is taken at face value, so an alias that is not a family name
 * (`default`, `best`) yields a "family" no runtime id will ever match. That is
 * deliberate: reconciliation then replaces it with the family actually running.
 */
export function modelFamily(model: string): string | null {
  const parsed = parseModelId(model);
  if (parsed) return parsed.family;
  const bare = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "");
  if (bare === "opusplan") return null;
  return /^[a-z]+$/.test(bare) ? bare : null;
}

interface ObservedFamily {
  family: string;
  version: string;
}

// "<Family> <version>" at the start of Claude Code's display name, e.g.
// "Fable 5.2 (1M context)". A version is required: a bare word proves nothing.
const DISPLAY_NAME = /^\s*([a-z]+)\s+(\d+(?:\.\d+)*)\b/i;

/** Families the runtime reports, the transcript id first, then the display name. */
function observedFamilies(displayName?: string, modelId?: string): ObservedFamily[] {
  const out: ObservedFamily[] = [];
  const parsed = parseModelId(modelId);
  if (parsed) out.push({ family: parsed.family, version: parsed.version });
  const dn = DISPLAY_NAME.exec(displayName ?? "");
  if (dn) out.push({ family: dn[1].toLowerCase(), version: dn[2] });
  return out;
}

/**
 * Whether the runtime model (Claude Code's `model.display_name`, e.g.
 * "<Family> <version> (1M context)", and/or the transcript model id, e.g.
 * "claude-<family>-<version>") is a valid resolution of the user-selected `model`
 * for the given permission mode.
 *
 * Compares **families** derived structurally (`modelFamily`, `parseModelId`), so
 * a family nobody listed reconciles exactly like opus/sonnet/haiku. A full model
 * id as `model` pins a version too, so it matches only that version.
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
  const observed = observedFamilies(displayName, modelId);
  const runs = (family: string): boolean => observed.some((o) => o.family === family);
  if (model === "opusplan") return permissionMode === "plan" ? runs("opus") : runs("sonnet");
  if (model === "haiku") return permissionMode === "plan" ? runs("sonnet") : runs("haiku");
  const pinned = parseModelId(model);
  if (pinned) {
    return observed.some((o) => o.family === pinned.family && o.version === pinned.version);
  }
  const family = modelFamily(model);
  if (!family) return false;
  // "plan" only ever appears in the display name, never the model id: Claude
  // Code's name for opusplan-in-plan, which a plain opus alias never produces.
  if (family === "opus" && /\bplan\b/.test((displayName ?? "").toLowerCase())) return false;
  return runs(family);
}

/**
 * Best-effort map from the observed runtime back to a value for `--model`.
 *
 * Family comes from the model id, else the display name. The answer is an alias
 * from `knownAliases` (aliases observed working, defaulting to the documented
 * seed list) when one names that family; otherwise the **full observed model
 * id**, which `--model` accepts. An alias is never invented: a family with no
 * known alias gets its id, never `<family>`.
 *
 * The 1M variant comes ONLY from the display name's "(1M context)" marker (the
 * model id can't express it), and only when `<family>[1m]` is itself a known
 * alias — so there is no `haiku[1m]`, nor one for a family where it was never
 * seen. Returns null when the family can't be determined — never guess.
 */
export function inferAliasFromRuntime(
  displayName?: string,
  modelId?: string,
  knownAliases: Iterable<ClaudeModel> = CLAUDE_MODELS,
): ClaudeModel | null {
  const observed = observedFamilies(displayName, modelId);
  if (observed.length === 0) return null;
  const { family } = observed[0];
  const known = [...knownAliases];
  if (/\(1m context\)/i.test(displayName ?? "")) {
    const oneM = known.find((a) => a === `${family}[1m]`);
    if (oneM) return oneM;
  }
  const plain = known.find((a) => a === family);
  if (plain) return plain;
  const id = modelId?.trim().toLowerCase();
  if (id && parseModelId(id)?.family === family && isClaudeModel(id)) return id;
  return null;
}

/**
 * Given the stored alias, the permission mode, and the observed runtime, return
 * a corrected alias when the stored one is provably wrong, else null (keep it).
 *
 * - Preserves `opusplan`/`haiku`: `displayNameMatchesIntent` treats their valid
 *   sub-model resolutions as a match, so they're never rewritten.
 * - Fixes family mismatches (the "shows Sonnet while running Opus" bug) for any
 *   family, including from a model-id-only signal (transcript) before the
 *   statusline. The correction is a known alias for the running family, or the
 *   full observed id when no alias for it is known (see `inferAliasFromRuntime`).
 * - Fixes 1M-ness only when the display name is present (the reliable 1M
 *   signal); a model-id-only read never flips a same-family alias.
 */
export function reconcileModelAlias(
  alias: ClaudeModel,
  permissionMode: PermissionMode,
  runtime: { displayName?: string; modelId?: string },
  knownAliases: Iterable<ClaudeModel> = CLAUDE_MODELS,
): ClaudeModel | null {
  const inferred = inferAliasFromRuntime(runtime.displayName, runtime.modelId, knownAliases);
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
