import { type FSWatcher, mkdirSync, readdirSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("session-locator");

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/**
 * Claude Code v2.1.126+ writes `~/.claude/sessions/<pid>.json` on session
 * boot, with `{ pid, sessionId, cwd, startedAt, ... }`. The transcript JSONL
 * is no longer pre-created — it only appears after the first user message —
 * so the old project-dir watcher had nothing to latch onto on fresh spawns.
 *
 * Matching by pid would be ideal but we wrap the PTY in `cmd.exe /c claude`
 * on Windows, so node-pty's IPty.pid is cmd.exe's pid, not claude.exe's.
 * We match by cwd + a `startedAt` lower bound (our spawn time) to avoid
 * picking up an unrelated concurrent session in the same project.
 */
export class SessionLocator {
  private watcher: FSWatcher | null = null;
  private settled = false;
  private readonly normalizedCwd: string;

  constructor(
    cwd: string,
    readonly spawnedAt: number,
    readonly onFound: (sessionId: string) => void,
  ) {
    this.normalizedCwd = normalizePath(cwd);
  }

  start(): void {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    } catch {}

    const seen = new Set<string>(safeReaddir(SESSIONS_DIR));

    // Try files that already existed when we attached — covers the race
    // where Claude beat us to writing the file before the watcher installed.
    for (const name of seen) {
      if (this.tryMatch(name)) return;
    }

    try {
      this.watcher = watch(SESSIONS_DIR, (_event, filename) => {
        if (this.settled || !filename) return;
        const name = filename.toString();
        if (!name.endsWith(".json")) return;
        // Don't re-check files already in the snapshot — they were filtered
        // out by tryMatch above (older sessions / wrong cwd / pre-spawn ts).
        if (seen.has(name)) return;
        seen.add(name);
        this.tryMatch(name);
      });
      this.watcher.on("error", (err) => {
        log.warn("watcher error", { error: err.message });
      });
    } catch (err) {
      log.warn("could not watch sessions dir", {
        dir: SESSIONS_DIR,
        error: (err as Error).message,
      });
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private tryMatch(filename: string): boolean {
    if (this.settled) return false;
    if (!filename.endsWith(".json")) return false;
    let raw: string;
    try {
      raw = readFileSync(join(SESSIONS_DIR, filename), "utf8");
    } catch {
      return false;
    }
    let parsed: { sessionId?: unknown; cwd?: unknown; startedAt?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return false;
    }
    const { sessionId, cwd, startedAt } = parsed;
    if (typeof sessionId !== "string" || !sessionId) return false;
    if (typeof cwd !== "string") return false;
    if (normalizePath(cwd) !== this.normalizedCwd) return false;
    // Reject files belonging to sessions started before our spawn — those are
    // unrelated concurrent claude processes in the same project. 1s tolerance
    // covers clock granularity / write ordering.
    if (typeof startedAt === "number" && startedAt < this.spawnedAt - 1000) return false;

    this.settled = true;
    this.stop();
    log.info("resolved session id", { filename, sessionId });
    this.onFound(sessionId);
    return true;
  }
}

function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, "/").toLowerCase();
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
