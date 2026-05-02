import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import type { PtyManagerEvents, PtySpawnOptions } from "../types/index.js";
import { LoggerService } from "./logger.service.js";

const log = LoggerService.scoped("pty");

export class PtyService extends EventEmitter<PtyManagerEvents> {
  private process: pty.IPty | null = null;

  spawn(options: PtySpawnOptions): void {
    if (this.process) {
      throw new Error("PTY process already running");
    }

    const args = ["--permission-mode", options.permissionMode];
    if (options.resumeSessionId) {
      // Omit --model on resume so Claude Code keeps the session's last model
      // (passing --model would force-switch, losing Opus/Sonnet[1m] etc).
      args.push("--resume", options.resumeSessionId);
    } else {
      args.push("--model", options.model);
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

    log.info("Spawning Claude Code", {
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      cols: options.cols,
      rows: options.rows,
      hooksEnabled: Boolean(options.settingsJson),
    });

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    const shellArgs =
      process.platform === "win32"
        ? ["/c", "claude", ...args]
        : [
            "-c",
            `claude ${args
              .map((a) =>
                a.startsWith("--") || /^[\w./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`,
              )
              .join(" ")}`,
          ];

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (options.effort && options.effort !== "auto") {
      // Per-session effort isolation — env wins over settings.json in Claude
      // Code's resolve chain, so a parallel session's `/effort` won't bleed in.
      // "auto" means "no override, use the model's default" — leave env unset.
      env.CLAUDE_CODE_EFFORT_LEVEL = options.effort;
    }

    this.process = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env,
    });

    this.process.onData((data) => {
      this.emit("data", data);
    });

    this.process.onExit(({ exitCode, signal }) => {
      log.info("Process exited", { exitCode, signal });
      this.process = null;
      this.emit("exit", { exitCode, signal });
    });

    // Catch async socket errors from conpty to prevent crashes
    const socket = (this.process as unknown as { _socket?: NodeJS.EventEmitter })._socket;
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

  kill(): void {
    if (!this.process) return;

    log.info("Killing PTY process");
    this.process.write("\x03");

    setTimeout(() => {
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
    }, 2000);
  }

  get running(): boolean {
    return this.process !== null;
  }
}
