// A bounded stdio protocol between the backend and this independent PTY host.
// Windows: launched inside a kill-on-close Job before spawning node-pty.
// Linux: a session-leader/subreaper supervisor uses pidfds for tree cleanup.
// Never consult a stale PID registry.
const pty = require("node-pty");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
let control;
let directory;
let terminal;
let closing = false;
let input = "";
let blocked = false;
function emit(value) {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`) && terminal && !blocked) {
    blocked = true;
    terminal.pause();
  }
}
process.stdout.on("drain", () => {
  blocked = false;
  if (!closing) terminal?.resume();
});
function stop(code = 0) {
  if (closing) return;
  closing = true;
  if (process.platform !== "win32" && control !== undefined) {
    fs.closeSync(control);
    control = undefined;
    // The supervisor keeps the PTY identity alive until its descendants die.
    if (terminal) return;
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  // On Windows exiting closes the launcher's Job, including every descendant.
  process.exit(code);
}
function dispatch(msg) {
  if (msg.type === "start" && !terminal) {
    let executable = msg.shell;
    let args = msg.args;
    if (process.platform !== "win32") {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "controller-terminal-"));
      const fifo = path.join(directory, "owner");
      execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
      control = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      executable = "/usr/bin/python3";
      args = [path.join(__dirname, "terminal-posix.py"), fifo, msg.shell, ...msg.args];
    }
    terminal = pty.spawn(executable, args, {
      cwd: msg.cwd,
      cols: msg.cols,
      rows: msg.rows,
      env: process.env,
      name: "xterm-256color",
      ...(process.platform === "win32" ? {} : { encoding: "utf8" }),
    });
    terminal.onData((data) => {
      // Split on scalar boundaries: no split UTF-8 or surrogate pairs.
      let part = "";
      let bytes = 0;
      for (const char of data) {
        const size = Buffer.byteLength(char);
        if (bytes + size > 8192) {
          emit({ type: "data", data: part });
          part = "";
          bytes = 0;
        }
        part += char;
        bytes += size;
      }
      if (part) emit({ type: "data", data: part });
    });
    terminal.onExit(({ exitCode }) => {
      terminal = undefined; // reaped identity must never be signalled later
      emit({ type: "exit", exitCode });
      process.stdout.end(() => {
        if (control !== undefined) fs.closeSync(control);
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
        process.exit(exitCode);
      });
    });
    emit({ type: "ready" });
  } else if (msg.type === "input" && terminal) {
    // node-pty 1.1.0 does not expose write backpressure. Inspect its two
    // platform queues, fail closed on overflow, and never grow them unbounded.
    const queue = terminal._writeStream?._writeQueue;
    const queued =
      process.platform === "win32"
        ? terminal._agent?.inSocket?.writableLength
        : queue?.reduce((sum, item) => sum + item.buffer.length - item.offset, 0);
    if (typeof queued !== "number" || queued + Buffer.byteLength(msg.data) > 65536) {
      emit({
        type: "error",
        message: "Terminal input buffer full or unsupported PTY queue; shell stopped safely",
      });
      stop(1);
      return;
    }
    terminal.write(msg.data);
  } else if (msg.type === "resize" && terminal) terminal.resize(msg.cols, msg.rows);
  else if (msg.type === "close") stop();
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  input += data;
  if (input.length > 128 * 1024) return stop(1);
  while (input.includes("\n")) {
    const newline = input.indexOf("\n");
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    try {
      dispatch(JSON.parse(line));
    } catch (error) {
      emit({ type: "error", message: error.message });
      stop(1);
    }
  }
});
process.stdin.on("end", () => stop());
process.stdin.on("error", () => stop(1));
process.stdout.on("error", () => stop(1));
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
