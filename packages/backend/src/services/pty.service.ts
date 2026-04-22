import { EventEmitter } from "node:events";
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

    const args = ["--model", options.model, "--permission-mode", options.permissionMode];
    if (options.settingsJson) {
      args.push("--settings", options.settingsJson);
      args.push("--setting-sources", "flag");
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
    // On Windows cmd.exe passes each array element as a separate argv entry
    // so the settings JSON (which contains quotes) stays intact without
    // additional shell-escaping. On Unix we assemble a single -c string and
    // must shell-escape the settings JSON.
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

    this.process = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: process.env as Record<string, string>,
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
