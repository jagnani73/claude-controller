import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBus, type SessionBusEvent } from "../../src/services/session-bus.service.js";
import { TranscriptWatcher } from "../../src/services/transcript.service.js";

function assistantEntry(opts: {
  id: string;
  text?: string;
  toolUse?: { id: string; name: string; input: unknown };
  stopReason?: string | null;
}): string {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  if (opts.toolUse)
    content.push({
      type: "tool_use",
      id: opts.toolUse.id,
      name: opts.toolUse.name,
      input: opts.toolUse.input,
    });
  return `${JSON.stringify({
    uuid: `u-${opts.id}`,
    parentUuid: null,
    sessionId: "claude-xyz",
    timestamp: "2026-04-22T00:00:00Z",
    cwd: "/tmp",
    version: "2.1.117",
    type: "assistant",
    message: {
      id: opts.id,
      model: "claude-sonnet-4",
      role: "assistant",
      type: "message",
      content,
      stop_reason: opts.stopReason ?? null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  })}\n`;
}

function userPromptEntry(text: string): string {
  return `${JSON.stringify({
    uuid: `uu-${Math.random()}`,
    parentUuid: null,
    sessionId: "claude-xyz",
    timestamp: "2026-04-22T00:00:00Z",
    cwd: "/tmp",
    version: "2.1.117",
    type: "user",
    message: { role: "user", content: text },
  })}\n`;
}

function userToolResultEntry(toolUseId: string, result: string): string {
  return `${JSON.stringify({
    uuid: `uu-${Math.random()}`,
    parentUuid: null,
    sessionId: "claude-xyz",
    timestamp: "2026-04-22T00:00:00Z",
    cwd: "/tmp",
    version: "2.1.117",
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result,
        },
      ],
    },
  })}\n`;
}

/** Wait until `predicate` is true or timeout expires. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("TranscriptWatcher", () => {
  let dir: string;
  let path: string;
  let bus: SessionBus;
  let events: SessionBusEvent[];
  let watcher: TranscriptWatcher | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transcript-test-"));
    path = join(dir, "transcript.jsonl");
    bus = new SessionBus("s1");
    events = [];
    bus.on("event", (e) => events.push(e));
  });

  afterEach(() => {
    watcher?.stop();
    watcher = null;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore on Windows file-lock races
    }
  });

  it("reads existing content on start", async () => {
    writeFileSync(
      path,
      assistantEntry({
        id: "t1",
        text: "hello",
        stopReason: "end_turn",
      }),
    );

    watcher = new TranscriptWatcher(path, bus);
    await watcher.start();

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("assistant_text");
  });

  it("maps user prompt entries to user_prompt events", async () => {
    writeFileSync(path, userPromptEntry("do a thing"));

    watcher = new TranscriptWatcher(path, bus);
    await watcher.start();

    const prompt = events.find((e) => e.kind === "user_prompt");
    expect(prompt).toBeTruthy();
    if (prompt?.kind !== "user_prompt") throw new Error("unreachable");
    expect(prompt.text).toBe("do a thing");
  });

  it("maps tool_use blocks to tool_call events", async () => {
    writeFileSync(
      path,
      assistantEntry({
        id: "t1",
        toolUse: {
          id: "tu-1",
          name: "Bash",
          input: { command: "ls" },
        },
        stopReason: "tool_use",
      }),
    );

    watcher = new TranscriptWatcher(path, bus);
    await watcher.start();

    const toolCall = events.find((e) => e.kind === "tool_call");
    expect(toolCall).toBeTruthy();
    if (toolCall?.kind !== "tool_call") throw new Error("unreachable");
    expect(toolCall.toolUseId).toBe("tu-1");
    expect(toolCall.name).toBe("Bash");
  });

  it("maps tool_result blocks on user entries to tool_result events", async () => {
    writeFileSync(path, userToolResultEntry("tu-1", "file1 file2"));

    watcher = new TranscriptWatcher(path, bus);
    await watcher.start();

    const result = events.find((e) => e.kind === "tool_result");
    expect(result).toBeTruthy();
    if (result?.kind !== "tool_result") throw new Error("unreachable");
    expect(result.toolUseId).toBe("tu-1");
    expect(result.result).toBe("file1 file2");
  });

  it("picks up new lines appended after start", async () => {
    writeFileSync(path, "");
    watcher = new TranscriptWatcher(path, bus);
    await watcher.start();

    await appendFile(
      path,
      assistantEntry({
        id: "t2",
        text: "appended",
        stopReason: "end_turn",
      }),
    );

    await waitFor(() => events.some((e) => e.kind === "assistant_text" && e.text === "appended"));
  });

  it("tolerates malformed lines and keeps going", async () => {
    writeFileSync(
      path,
      `not valid json\n${assistantEntry({
        id: "t3",
        text: "still works",
        stopReason: "end_turn",
      })}`,
    );

    watcher = new TranscriptWatcher(path, bus);
    await watcher.start();

    const assistant = events.find((e) => e.kind === "assistant_text");
    expect(assistant).toBeTruthy();
    if (assistant?.kind !== "assistant_text") throw new Error("unreachable");
    expect(assistant.text).toBe("still works");
  });

  it("does not throw when the file doesn't exist yet", async () => {
    const missing = join(dir, "does-not-exist.jsonl");
    watcher = new TranscriptWatcher(missing, bus);
    await watcher.start();
    expect(events).toHaveLength(0);
  });
});
