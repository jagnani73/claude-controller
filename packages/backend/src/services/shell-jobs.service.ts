import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ShellJob, ShellJobServerMessage, ShellJobStatus } from "common/shell-job-types";
import type { TranscriptEntry, UserEntry } from "../types/transcript.types.js";

const MAX_JOBS = 128;
const MAX_CALLS = 512;
export const SHELL_OUTPUT_BYTES = 32 * 1024;
const safeId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_-]{1,128}$/.test(value) &&
  !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(value);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value.slice(0, 2048) : "");

export function isTaskNotification(entry: UserEntry): boolean {
  return (
    entry.origin?.kind === "task-notification" &&
    entry.origin?.producer === "session-task" &&
    entry.promptSource === "system" &&
    entry.turnOrigin === "task_notification"
  );
}

/** One per session. No output paths from hooks, messages or clients are trusted. */
export class ShellJobs {
  private jobs = new Map<string, ShellJob>();
  private calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private overflow = false;
  private closed = false;
  private busy = false;
  private root: string | null = null;
  constructor(
    readonly sessionId: string,
    private readonly cwd: string,
  ) {}

  /** Called with the exact environment passed to node-pty, not hook cwd. */
  setChildEnvironment(env: Record<string, string>): void {
    const temp = process.platform === "win32" ? env.TEMP || env.TMP : env.TMPDIR || "/tmp";
    // Require a normal local drive on Windows: no UNC, device namespace, or ADS.
    const ordinaryRoot =
      process.platform !== "win32" ||
      (typeof temp === "string" && /^[a-zA-Z]:[\\/]/.test(temp) && !temp.slice(2).includes(":"));
    // Custom CLI temp layouts have not been probed. Fail closed rather than guess.
    this.root =
      temp &&
      isAbsolute(temp) &&
      ordinaryRoot &&
      !temp.includes("\u0000") &&
      !env.CLAUDE_CODE_TMPDIR
        ? resolve(temp, "claude")
        : null;
  }
  snapshot(): { jobs: ShellJob[]; truncated: boolean } {
    return { jobs: [...this.jobs.values()].map((j) => ({ ...j })), truncated: this.overflow };
  }
  hasRunning(): boolean {
    return [...this.jobs.values()].some((j) => j.status === "running");
  }
  settle(): void {
    for (const job of this.jobs.values()) if (job.status === "running") job.status = "unknown";
  }
  close(): void {
    this.closed = true;
    this.settle();
  }

  private remember(id: string, name: string, input: unknown): void {
    if (!safeId(id) || (name !== "Bash" && name !== "TaskStop")) return;
    if (this.calls.size >= MAX_CALLS) this.calls.delete(this.calls.keys().next().value as string);
    const value = object(input);
    this.calls.set(id, {
      name,
      input: { command: text(value.command), description: text(value.description) },
    });
  }
  private launch(id: unknown, toolId: unknown, source: ShellJob["source"]): void {
    if (!safeId(id) || !safeId(toolId)) return;
    const call = this.calls.get(toolId);
    if (call?.name !== "Bash") return;
    const existing = this.jobs.get(id);
    if (existing) {
      // A live hook can re-establish liveness, but never resurrect a terminal job.
      if (existing.toolUseId === toolId && existing.status === "unknown" && source === "hook") {
        existing.status = "running";
        existing.source = source;
      }
      return;
    }
    if (this.jobs.size >= MAX_JOBS) {
      this.overflow = true;
      return;
    }
    this.jobs.set(id, {
      id,
      toolUseId: toolId,
      command: text(call.input.command),
      description: text(call.input.description),
      contextCwd: this.cwd.slice(0, 2048),
      status: source === "replay" ? "unknown" : "running",
      source,
      exitCode: null,
    });
  }
  private result(toolId: string, result: unknown, source: ShellJob["source"]): void {
    const value = object(result);
    this.launch(value.backgroundTaskId, toolId, source);
    if (
      this.calls.get(toolId)?.name === "TaskStop" &&
      value.task_type === "local_bash" &&
      safeId(value.task_id)
    ) {
      const job = this.jobs.get(value.task_id);
      // The structured TaskStop result is only delivered on a successful hook/result.
      if (job && (job.status === "running" || job.status === "unknown")) {
        job.status = "stopped";
        job.source = source;
      }
    }
  }
  hook(event: string, payload: unknown): void {
    if (this.closed) return;
    const p = object(payload);
    if (p.agent_id || p.session_id !== this.sessionId) return;
    if (event === "PostToolUse" && typeof p.tool_use_id === "string") {
      this.remember(p.tool_use_id, text(p.tool_name), p.tool_input);
      this.result(p.tool_use_id, p.tool_response, "hook");
    } else if (event === "Stop" && Array.isArray(p.background_tasks)) {
      for (const value of p.background_tasks.slice(0, MAX_JOBS)) {
        const task = object(value);
        const job = typeof task.id === "string" ? this.jobs.get(task.id) : undefined;
        if (job && task.type === "shell" && task.status === "running" && job.status === "unknown") {
          job.status = "running";
          job.source = "hook";
        }
      }
    }
  }
  transcript(entry: TranscriptEntry, replay: boolean): void {
    if (this.closed) return;
    const source = replay ? "replay" : "transcript";
    if (entry.type === "assistant") {
      const e = entry as import("../types/transcript.types.js").AssistantEntry;
      for (const block of e.message.content ?? [])
        if (block.type === "tool_use") this.remember(block.id, block.name, block.input);
    }
    if (entry.type !== "user" || object(entry).isSidechain || object(entry).agentId) return;
    const e = entry as UserEntry;
    if (Array.isArray(e.message.content)) {
      for (const block of e.message.content)
        if (block.type === "tool_result" && !block.is_error)
          this.result(block.tool_use_id, e.toolUseResult, source);
    }
    if (!isTaskNotification(e)) return;
    const content =
      typeof e.message.content === "string"
        ? e.message.content
        : e.message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    // XML is considered only AFTER structural provenance, and must match a known mapping.
    for (const match of content
      .slice(0, 65536)
      .matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const field = (key: string) => match[1].match(new RegExp(`<${key}>([^<]*)</${key}>`))?.[1];
      const id = field("task-id");
      const job = id ? this.jobs.get(id) : undefined;
      const status = field("status");
      if (
        job &&
        job.toolUseId === field("tool-use-id") &&
        (status === "completed" || status === "failed" || status === "stopped")
      ) {
        job.status = status as ShellJobStatus;
        job.source = source;
      }
    }
  }

  async output(
    jobId: string,
    cursor?: number,
  ): Promise<Extract<ShellJobServerMessage, { type: "shell_job_output" }>> {
    const response: Extract<ShellJobServerMessage, { type: "shell_job_output" }> = {
      type: "shell_job_output",
      sessionId: this.sessionId,
      jobId,
      text: "",
      offset: 0,
      reset: true,
      truncated: false,
    };
    if (this.busy) return { ...response, error: "Output read busy; retry." };
    this.busy = true;
    try {
      if (
        this.closed ||
        !this.root ||
        !safeId(this.sessionId) ||
        !safeId(jobId) ||
        !this.jobs.has(jobId)
      )
        throw new Error("Output unavailable: unknown job or unverified temp layout.");
      const root = this.root;
      const rootReal = await realpath(root);
      if (resolve(rootReal) !== resolve(root) || !(await lstat(root)).isDirectory())
        throw new Error("Unsafe temp root.");
      const directory = await opendir(root);
      let candidate: string | null = null;
      let count = 0;
      for await (const bucket of directory) {
        if (++count > 128) throw new Error("Output unavailable: temp bucket scan limit reached.");
        if (!bucket.isDirectory() || !safeId(bucket.name)) continue;
        const path = join(root, bucket.name, this.sessionId, "tasks", `${jobId}.output`);
        try {
          await this.validatePath(root, path);
          if (candidate) throw new Error("Ambiguous output layout.");
          candidate = path;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      if (!candidate) throw new Error("Output unavailable: file not found in verified layout.");
      const before = await lstat(candidate);
      const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (info.nlink > 1) throw new Error("Output unavailable: hard-linked files are refused.");
        await this.validatePath(root, candidate);
        if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev)
          throw new Error("Output file changed during open.");
        const requested =
          Number.isSafeInteger(cursor) && (cursor as number) >= 0 ? (cursor as number) : null;
        let start =
          requested !== null && requested <= info.size
            ? requested
            : Math.max(0, info.size - SHELL_OUTPUT_BYTES);
        if (info.size - start > SHELL_OUTPUT_BYTES) start = info.size - SHELL_OUTPUT_BYTES;
        response.reset = requested !== start;
        response.truncated = start > 0 && response.reset;
        const buffer = Buffer.alloc(Math.min(SHELL_OUTPUT_BYTES, info.size - start));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        let first = 0;
        while (first < bytesRead && (buffer[first] & 0xc0) === 0x80) first++;
        let end = bytesRead;
        // Hold incomplete trailing UTF-8 bytes by leaving the cursor before them.
        let lead = end - 1;
        while (lead >= first && (buffer[lead] & 0xc0) === 0x80) lead--;
        if (lead >= first) {
          const byte = buffer[lead];
          const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
          if (end - lead < need) end = lead;
        }
        response.text = buffer.subarray(first, end).toString("utf8");
        response.offset = start + end;
        if (this.closed) throw new Error("Session closed.");
        return response;
      } finally {
        await handle.close();
      }
    } catch (error) {
      return {
        ...response,
        text: "",
        error: error instanceof Error ? error.message : "Output unavailable.",
      };
    } finally {
      this.busy = false;
    }
  }
  private async validatePath(root: string, path: string): Promise<void> {
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe output path.");
    let current = root;
    for (const segment of rel.split(/[\\/]/)) {
      current = join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || resolve(await realpath(current)) !== resolve(current))
        throw new Error("Linked output paths are unavailable.");
    }
    if (!(await lstat(path)).isFile()) throw new Error("Output is not a regular file.");
  }
}
