import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_LIMITS } from "common/terminal-types";

export function terminalEnvironment(): NodeJS.ProcessEnv {
  // Interactive shells get normal tools/PATH, but no inherited Claude identity,
  // hook settings, effort overrides or Node injection into the trusted host.
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !/^(CLAUDE|ANTHROPIC_|NODE_|PYTHON|LD_PRELOAD$|LD_LIBRARY_PATH$|DYLD_)/i.test(key),
    ),
  );
}

export function terminalShell(): { shell: string; args: string[]; launcher?: string } {
  if (process.platform === "win32") {
    const launcher = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    // Never PATH/cwd-resolve pwsh (a repository may contain a lookalike).
    const candidate = join(
      process.env.ProgramFiles || "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    const shell =
      existsSync(candidate) && realpathSync(candidate).toLowerCase() === candidate.toLowerCase()
        ? candidate
        : launcher;
    return {
      shell,
      launcher,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-Command",
        "[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding",
      ],
    };
  }
  // Fail closed rather than ship PID-tree killing on kernels without pidfds.
  if (process.platform !== "linux")
    throw new Error(
      "Interactive terminals currently require Windows or Linux (safe process ownership)",
    );
  if (!existsSync("/usr/bin/python3"))
    throw new Error("Linux terminals require /usr/bin/python3 with pidfd support");
  const preferred = userInfo().shell;
  let allowed: string[] = [];
  try {
    allowed = readFileSync("/etc/shells", "utf8")
      .split(/\r?\n/)
      .filter((s) => s.startsWith("/"));
  } catch {
    /* use safe fallback */
  }
  const shell =
    preferred &&
    isAbsolute(preferred) &&
    allowed.includes(preferred) &&
    statSync(preferred).isFile()
      ? preferred
      : "/bin/sh";
  return { shell, args: ["-i"] };
}

type ProcessEvent =
  | { type: "ready" }
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string };

/** Never spawns, reads, writes, or signals a Claude PTY. */
export class TerminalProcess {
  private child: ChildProcessWithoutNullStreams;
  private ended = false;
  private buffer = "";
  private errorText = "";
  private outcome: ProcessEvent | null = null;
  private startup: ReturnType<typeof setTimeout>;

  constructor(
    options: { cwd: string; cols: number; rows: number; shell: ReturnType<typeof terminalShell> },
    private event: (event: ProcessEvent) => void,
  ) {
    const runner = fileURLToPath(new URL("../../scripts/terminal-host.cjs", import.meta.url));
    const job = fileURLToPath(new URL("../../scripts/terminal-job.ps1", import.meta.url));
    this.child = spawn(
      options.shell.launcher || process.execPath,
      options.shell.launcher
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            job,
            process.execPath,
            runner,
          ]
        : [runner],
      { stdio: "pipe", windowsHide: true, env: terminalEnvironment(), cwd: options.cwd },
    );
    this.startup = setTimeout(() => {
      this.outcome = { type: "error", message: "Shell startup timed out" };
      this.close();
    }, 15_000);
    this.startup.unref();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data: string) => this.receive(data));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (data: string) => {
      this.errorText = (this.errorText + data).slice(-2048);
    });
    this.child.stdin.on("error", () => this.close());
    this.child.on("error", (error) => {
      this.outcome = { type: "error", message: error.message };
      this.close();
    });
    this.child.on("close", (code) => {
      clearTimeout(this.startup);
      if (!this.ended)
        this.event(
          this.outcome ??
            (this.errorText
              ? { type: "error", message: this.errorText }
              : { type: "exit", exitCode: code ?? 1 }),
        );
      this.ended = true;
      this.child.removeAllListeners();
    });
    this.send({ type: "start", ...options, shell: options.shell.shell, args: options.shell.args });
  }

  private receive(data: string): void {
    this.buffer += data;
    if (this.buffer.length > 256 * 1024) {
      this.close();
      return;
    }
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const msg = JSON.parse(line) as ProcessEvent;
        if (msg.type === "ready") clearTimeout(this.startup);
        // The worker is trusted. All externally supplied input is validated by
        // TerminalManager before crossing the bounded pipe.
        if (msg.type === "exit" || msg.type === "error") this.outcome = msg;
        else this.event(msg);
      } catch {
        this.close();
      }
    }
  }

  send(message: object): boolean {
    if (
      this.ended ||
      !this.child.stdin.writable ||
      this.child.stdin.writableLength > TERMINAL_LIMITS.queueBytes
    )
      return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  close(): void {
    clearTimeout(this.startup);
    // Closing the owned pipe causes the job owner to exit on Windows and the
    // POSIX host to kill its current group. No taskkill or delayed PID signal.
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }
}
