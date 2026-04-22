import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HooksService } from "../../src/services/hooks.service.js";
import { SessionBus } from "../../src/services/session-bus.service.js";

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
  const buses = new Map<string, SessionBus>();

  beforeEach(async () => {
    buses.clear();
    service = new HooksService((sessionId) => buses.get(sessionId) ?? null);
    await service.start();
    baseUrl = service.baseUrl();
  });

  afterEach(() => {
    service.stop();
  });

  it("exposes a loopback base URL after start", () => {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
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

    await new Promise<void>((resolve) => {
      const check = () => {
        if (gotToolUseId) resolve();
        else setTimeout(check, 10);
      };
      check();
    });

    const toolUseId = gotToolUseId as string | null;
    expect(toolUseId).toBeTruthy();

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
    const res = await post(`${baseUrl}/hooks/unknown-session/PermissionRequest`, {
      hook_event_name: "PermissionRequest",
      session_id: "claude-xyz",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: {},
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({});
  });

  it("returns 404 for an unrecognized path", async () => {
    const res = await post(`${baseUrl}/not/hooks/at/all`, {});
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/hooks/s-x/PermissionRequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(400);
  });
});
