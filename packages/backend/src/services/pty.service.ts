import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import type { PtyManagerEvents, PtySpawnOptions } from "../types/index.js";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("pty");

/**
 * Environment variables that must never reach the spawned CLI. Two groups, both
 * of which fail *silently* — the session runs and looks healthy while a load-
 * bearing signal is missing.
 *
 * 1. **Parent-session identity markers.** If the backend is launched from inside
 *    a Claude Code session — the normal dev workflow, and anyone starting the
 *    controller from a Claude Code terminal — the child inherits these and
 *    concludes it is a nested invocation. `CLAUDE_CODE_CHILD_SESSION` in
 *    particular makes it **disable transcript saving**, removing the
 *    controller's primary data source: no JSONL, the locator never resolves an
 *    id, and the session looks dead rather than broken.
 *
 * 2. **Safe mode** (`CLAUDE_CODE_SAFE_MODE`, added upstream in 2.1.169) starts
 *    the CLI with all customizations disabled — *including hooks*, which are the
 *    controller's entire control surface: approvals, the plan card, compaction,
 *    statusline metadata. Verified by direct experiment against 2.1.251: with a
 *    `PreToolUse` HTTP hook injected via `--settings`, a control run fired 1
 *    hook while both `--safe-mode` and `CLAUDE_CODE_SAFE_MODE=1` fired 0 — each
 *    still exiting 0 with the tool executed, so there is no error to notice.
 *    The controller cannot function without hooks, so it must never inherit it.
 *
 * Deliberately an explicit list, not a `CLAUDE*` prefix sweep: config vars like
 * `CLAUDE_CONFIG_DIR` are legitimately inherited, and `CLAUDE_CODE_EFFORT_LEVEL`
 * is one we set ourselves below.
 */
export const STRIPPED_CHILD_ENV = [
  // Parent-session identity
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  // 2.1.317+: makes a nested CLI reuse the parent's session id and transcript
  "CLAUDE_CODE_DISABLE_NESTED_SESSION_ID",
  // Disables hooks entirely — see (2) above
  "CLAUDE_CODE_SAFE_MODE",
] as const;

/** POSIX single-quote wrap; bare flags and plain paths pass through unquoted. */
function shellQuote(arg: string): string {
  if (arg.startsWith("--") || /^[\w./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export class PtyService extends EventEmitter<PtyManagerEvents> {
  private process: pty.IPty | null = null;

  spawn(options: PtySpawnOptions): void {
    if (this.process) {
      throw new Error("PTY process already running");
    }

    const args = ["--permission-mode", options.permissionMode];
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
      // Omit --model on resume to preserve the session's last model — passing
      // it would force-switch and lose flavors like Opus[1m]/opusplan. Set
      // forceModel when the user has explicitly picked a different model.
      if (options.forceModel) args.push("--model", options.model);
    } else {
      args.push("--model", options.model);
      // A fresh session's id is chosen by us, not discovered: several sessions
      // started in one folder at once are otherwise indistinguishable.
      if (options.newSessionId) args.push("--session-id", options.newSessionId);
    }
    if (options.settingsJson) {
      // Pass via file path, not inline — cmd.exe strips the quotes off inline JSON.
      const settingsPath = join(tmpdir(), `claude-controller-settings-${randomUUID()}.json`);
      writeFileSync(settingsPath, options.settingsJson, "utf8");
      log.info("Wrote --settings file", {
        path: settingsPath,
        bytes: options.settingsJson.length,
        preview: options.settingsJson.slice(0, 300),
      });
      args.push("--settings", settingsPath);
    }

    // Log the launch command: on a machine with more than one Claude Code
    // install, which binary runs is decided by PATH order, and the resulting
    // version drift is otherwise invisible until a relay misbehaves. The version
    // that actually ran is reported separately from the transcript.
    log.info("Spawning Claude Code", {
      cwd: options.cwd,
      claudeBin: options.claudeBin,
      model: options.model,
      permissionMode: options.permissionMode,
      cols: options.cols,
      rows: options.rows,
      hooksEnabled: Boolean(options.settingsJson),
    });

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    const shellArgs =
      process.platform === "win32"
        ? // node-pty quotes argv entries containing spaces, so an absolute
          // CLAUDE_BIN path survives without hand-quoting here.
          ["/c", options.claudeBin, ...args]
        : ["-c", [options.claudeBin, ...args].map(shellQuote).join(" ")];

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const inherited = STRIPPED_CHILD_ENV.filter((key) => key in env);
    for (const key of inherited) delete env[key];
    if (inherited.length > 0) {
      log.info("Stripped inherited Claude Code env from child", { stripped: inherited });
    }
    // Reported separately: safe mode is the operator's own setting, so silently
    // overriding it would be surprising. Dropped regardless — the controller has
    // no working mode without hooks.
    //
    // error, not warn: `warn` is outside the default `info,error` log level, so
    // a warning here would itself be silent — the exact failure this guards
    // against (same reasoning as statusLineDumpScriptPath).
    if (inherited.includes("CLAUDE_CODE_SAFE_MODE")) {
      log.error("CLAUDE_CODE_SAFE_MODE was set and has been dropped for this session", {
        reason: "safe mode disables hooks, which the controller depends on entirely",
      });
    }
    // Agent teams are what let agents message each other (SendMessage between
    // teammates); without the flag the agents view only ever shows plain
    // subagents that never talk. Experimental upstream and behind a killswitch,
    // so an operator who set it explicitly (e.g. "0") keeps their choice.
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ??= "1";
    if (options.effort && options.effort !== "auto") {
      // Per-session effort isolation — env wins over settings.json in Claude
      // Code's resolve chain, so a parallel session's `/effort` won't bleed in.
      // "auto" means "no override, use the model's default" — leave env unset.
      env.CLAUDE_CODE_EFFORT_LEVEL = options.effort;
    }

    const proc = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env,
    });
    this.process = proc;

    proc.onData((data) => {
      // A killed process can still flush output after its replacement spawned.
      if (this.process === proc) this.emit("data", data);
    });

    proc.onExit(({ exitCode, signal }) => {
      // `kill({immediate})` forgets the process at once, so its exit can arrive
      // after a respawn has started the next one. Reporting it then would clear
      // the live process and tell the session it died.
      if (this.process !== null && this.process !== proc) {
        log.info("Replaced process exited", { exitCode, signal });
        return;
      }
      log.info("Process exited", { exitCode, signal });
      this.process = null;
      this.emit("exit", { exitCode, signal });
    });

    // Catch async socket errors from conpty to prevent crashes
    const socket = (proc as unknown as { _socket?: NodeJS.EventEmitter })._socket;
    if (socket) {
      socket.on("error", (err: Error) => {
        log.warn("PTY socket error", { error: err.message });
      });
    }
  }

  write(data: string): boolean {
    if (!this.process) {
      log.warn("Write to dead PTY, ignoring");
      return false;
    }
    try {
      this.process.write(data);
      return true;
    } catch (err) {
      log.warn("PTY write failed", { error: err });
      return false;
    }
  }

  resize(cols: number, rows: number): void {
    if (this.process) {
      log.debug("Resizing PTY", { cols, rows });
      this.process.resize(cols, rows);
    }
  }

  /**
   * Default: Ctrl+C then SIGKILL after 2s, giving Claude Code a chance to flush
   * state. `immediate` skips that grace period — use when no clean shutdown is
   * needed (e.g. about to respawn with --resume).
   */
  kill(opts: { immediate?: boolean } = {}): void {
    if (!this.process) return;

    log.info("Killing PTY process", { immediate: !!opts.immediate });
    if (opts.immediate) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
      return;
    }
    const proc = this.process;
    proc.write("\x03");

    // Only the process this call was asked to kill: a respawn may have
    // replaced it within the grace period.
    setTimeout(() => {
      if (this.process === proc) {
        try {
          proc.kill();
        } catch {}
        this.process = null;
      }
    }, 2000);
  }

  get running(): boolean {
    return this.process !== null;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }
}
