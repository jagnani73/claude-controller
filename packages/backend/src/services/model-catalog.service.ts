import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseModelId } from "common/model";
import type { ClaudeModel, ModelCatalog } from "common/types";
import { CLAUDE_MODELS, isClaudeModel, isKnownClaudeModel } from "common/types";
import { compareVersions } from "common/version";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("model-catalog");

/** Where an alias was seen working. Logged only; every source counts the same. */
export type AliasSource = "PostModelSwitch" | "pick" | "settings.json";

/**
 * Model aliases and families learned at runtime, in memory (there is no
 * database, and no machine-readable model list we may query: the models API
 * needs an API key, and reading the TUI's `/model` picker would be PTY parsing).
 *
 * Reconciliation corrects a stale alias to one of {@link knownAliases} when one
 * names the running family, and otherwise to the full observed model id. So an
 * alias is used only once it has actually been seen working: a `PostModelSwitch`
 * `requested_model`, a pick made in the controller, or the `model` in the user's
 * `~/.claude/settings.json`. Families come from transcript model ids and only
 * feed the picker's version hints.
 */
export class ModelCatalogService extends EventEmitter<{ changed: [] }> {
  private readonly learned = new Set<ClaudeModel>();
  /** Newest observed model id per family. */
  private readonly latestIds = new Map<string, { id: string; version: string }>();

  /** Record an alias seen working. Ignores junk and the documented seed aliases. */
  learnAlias(value: string | undefined, source: AliasSource): void {
    if (!value || !isClaudeModel(value) || isKnownClaudeModel(value)) return;
    if (this.learned.has(value)) return;
    this.learned.add(value);
    log.info("Learned model alias", { alias: value, source });
    this.emit("changed");
  }

  /** Record a model id seen in a transcript or a hook, keeping the newest per family. */
  observeModelId(modelId: string | undefined): void {
    const parsed = parseModelId(modelId);
    if (!modelId || !parsed) return;
    const best = this.latestIds.get(parsed.family);
    if (best && compareVersions(parsed.version, best.version) <= 0) return;
    this.latestIds.set(parsed.family, {
      id: modelId.trim().toLowerCase(),
      version: parsed.version,
    });
    this.emit("changed");
  }

  /** The documented seed aliases plus every learned one: what reconciliation may use. */
  knownAliases(): ClaudeModel[] {
    return [...CLAUDE_MODELS, ...this.learned];
  }

  snapshot(): ModelCatalog {
    return {
      aliases: [...this.learned],
      modelIds: [...this.latestIds.values()].map((entry) => entry.id),
    };
  }

  /** Learn the user's default model from `~/.claude/settings.json`, if it has one. */
  loadUserSettings(path = join(homedir(), ".claude", "settings.json")): void {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown };
      if (typeof parsed.model === "string") this.learnAlias(parsed.model, "settings.json");
    } catch {
      // Missing or unreadable settings are normal; there is simply nothing to learn.
    }
  }
}

/** One catalog per backend process, shared by every session. */
export const modelCatalog = new ModelCatalogService();
