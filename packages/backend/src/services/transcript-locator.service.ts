import { type FSWatcher, readdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("transcript-locator");

/**
 * Claude Code writes each session's transcript to
 * `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` where the cwd is encoded
 * by replacing every path separator (`:`, `\`, `/`) with `-`.
 *
 * We can't use `SessionStart` HTTP hooks to learn the path — Claude Code
 * only supports command-type hooks for that event — so instead we snapshot
 * the project dir just before spawning the PTY, then watch for a new
 * `.jsonl` file to appear. The first new file is our session.
 */
export class TranscriptLocator {
  private watcher: FSWatcher | null = null;
  private settled = false;

  constructor(
    readonly cwd: string,
    readonly onFound: (transcriptPath: string) => void,
  ) {}

  start(): void {
    const dir = resolveProjectDir(this.cwd);
    const seen = new Set<string>(safeReaddir(dir));
    log.debug("watching project dir", { dir, existing: seen.size });

    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (this.settled || !filename) return;
        const name = filename.toString();
        if (!name.endsWith(".jsonl")) return;
        if (seen.has(name)) return;
        seen.add(name);
        this.settled = true;
        const fullPath = join(dir, name);
        log.info("found transcript", { path: fullPath });
        this.stop();
        this.onFound(fullPath);
      });
      this.watcher.on("error", (err) => {
        log.warn("watcher error", { error: err.message });
      });
    } catch (err) {
      log.warn("could not watch project dir", {
        dir,
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
}

/** Resolve `D:\Work\claude-controller` → `<home>/.claude/projects/D--Work-claude-controller`. */
function resolveProjectDir(cwd: string): string {
  const encoded = cwd.replaceAll(/[:\\/]/g, "-");
  return join(homedir(), ".claude", "projects", encoded);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
