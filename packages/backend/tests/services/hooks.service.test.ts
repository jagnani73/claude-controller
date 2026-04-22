import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { HooksService } from "../../src/services/hooks.service.js";
import { SessionBus } from "../../src/services/session-bus.service.js";
import type { TranscriptWatcher } from "../../src/services/transcript.service.js";

/** Minimal TranscriptWatcher stub — we don't test disk I/O here. */
function makeWatcherFactory() {
  const created: Array<{ sessionId: string; path: string }> = [];
  const factory = (sessionId: string, path: string): TranscriptWatcher => {
    created.push({ sessionId, path });
    return {
      start: mock(async () => {}),
      stop: mock(() => {}),
      path,
    } as unknown as TranscriptWatcher;
  };
  return { factory, created };
}

async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

describe("HooksService", () => {
  let service: HooksService;
  let baseUrl: string;
  let watcherCreated: Array<{ sessionId: string; path: string }>;
  const buses = new Map<string, SessionBus>();

  beforeEach(async () => {
    buses.clear();
    const { factory, created } = makeWatcherFactory();
    watcherCreated = created;
    service = new HooksService((sessionId) => buses.get(sessionId) ?? null, factory);
    await service.start();
    baseUrl = service.baseUrl();
  });

  afterEach(() => {
    service.stop();
  });

  it("exposes a loopback base URL after start", () => {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("SessionStart starts a transcript watcher with the payload path", async () => {
    const bus = new SessionBus("s-2");
    buses.set("s-2", bus);

    const res = await post(`${baseUrl}/hooks/s-2/SessionStart`, {
      hook_event_name: "SessionStart",
      session_id: "claude-xyz",
      transcript_path: "/tmp/xyz.jsonl",
      cwd: "/tmp",
      source: "startup",
      model: "sonnet",
    });

    expect(res.status).toBe(200);
    expect(watcherCreated).toHaveLength(1);
    expect(watcherCreated[0]).toEqual({
      sessionId: "s-2",
      path: "/tmp/xyz.jsonl",
    });
  });

  it("PermissionRequest blocks until resolveApproval is called", async () => {
    const bus = new SessionBus("s-3");
    buses.set("s-3", bus);

    let gotToolUseId: string | null = null;
    bus.on("event", (e) => {
      if (e.kind === "approval_request") {
        gotToolUseId = e.toolUseId;
      }
    });

    const pending = post(`${baseUrl}/hooks/s-3/PermissionRequest`, {
      hook_event_name: "PermissionRequest",
      session_id: "claude-abc",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    // Wait for the approval_request event to land
    await new Promise<void>((resolve) => {
      const check = () => {
        if (gotToolUseId) resolve();
        else setTimeout(check, 10);
      };
      check();
    });

    const toolUseId = gotToolUseId as string | null;
    expect(toolUseId).toBeTruthy();

    // Nothing resolved yet
    const resolved = service.resolveApproval(
      "s-3",
      toolUseId as string,
      "allow",
      "approved by test",
    );
    expect(resolved).toBe(true);

    const { status, json } = await pending;
    expect(status).toBe(200);
    const response = json as {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    expect(response.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(response.hookSpecificOutput?.permissionDecisionReason).toBe("approved by test");
  });

  it("resolveApproval returns false when no approval is pending", () => {
    expect(service.resolveApproval("nobody", "tu-1", "allow")).toBe(false);
  });

  it("returns empty JSON when the session bus is unknown", async () => {
    const res = await post(`${baseUrl}/hooks/unknown-session/SessionStart`, {
      hook_event_name: "SessionStart",
      session_id: "claude-xyz",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      source: "startup",
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({});
  });

  it("returns 404 for an unrecognized path", async () => {
    const res = await post(`${baseUrl}/not/hooks/at/all`, {});
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/hooks/s-x/SessionStart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(400);
  });
});
