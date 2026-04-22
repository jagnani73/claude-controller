import { createServer, type Server } from "node:http";
import type {
  HookEventName,
  HookPayload,
  HookResponse,
  PermissionRequestPayload,
} from "../types/hook.types.js";
import { LoggerService } from "./logger.service.js";
import type { SessionBus } from "./session-bus.service.js";

const log = LoggerService.scoped("hooks");

const LOOPBACK_HOST = "127.0.0.1";

type BusLookup = (sessionId: string) => SessionBus | null;

/**
 * HTTP listener for Claude Code hook POSTs.
 *
 * Claude Code only supports HTTP hooks for certain events — `SessionStart` is
 * command-only, for example. We therefore register just `PermissionRequest`,
 * which blocks until the phone approves or denies via `resolveApproval()`.
 *
 * Binds loopback-only — Claude Code's SSRF guard blocks private IPs.
 */
export class HooksService {
  private server: Server | null = null;
  private port = 0;
  private pendingApprovals = new Map<string, (response: HookResponse) => void>();

  constructor(private readonly busLookup: BusLookup) {}

  /** Start listening on an ephemeral loopback port; returns the assigned port. */
  async start(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          log.error("request handler error", { error: (err as Error).message });
          if (!res.headersSent) res.writeHead(500).end();
        });
      });
      server.once("error", reject);
      server.listen(0, LOOPBACK_HOST, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("failed to bind hooks listener"));
          return;
        }
        this.server = server;
        this.port = addr.port;
        log.info("listening", { url: this.baseUrl() });
        resolve(addr.port);
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const [, resolver] of this.pendingApprovals) {
      resolver({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "controller shutting down",
        },
      });
    }
    this.pendingApprovals.clear();
  }

  baseUrl(): string {
    return `http://${LOOPBACK_HOST}:${this.port}`;
  }

  /** Resolve a pending approval from the phone. Returns false if not pending. */
  resolveApproval(
    sessionId: string,
    toolUseId: string,
    decision: "allow" | "deny",
    reason?: string,
  ): boolean {
    const key = approvalKey(sessionId, toolUseId);
    const resolver = this.pendingApprovals.get(key);
    if (!resolver) return false;
    this.pendingApprovals.delete(key);
    resolver({
      hookSpecificOutput: {
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    });
    return true;
  }

  private async handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const url = req.url ?? "";
    const match = /^\/hooks\/([^/]+)\/([^/?]+)/.exec(url);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const [, sessionId, eventName] = match;

    const body = await readBody(req);
    let payload: HookPayload;
    try {
      payload = JSON.parse(body) as HookPayload;
    } catch {
      res.writeHead(400).end("invalid json");
      return;
    }

    log.debug("hook received", { sessionId, event: eventName });

    const response = await this.route(sessionId, eventName as HookEventName, payload);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  }

  private async route(
    sessionId: string,
    event: HookEventName,
    payload: HookPayload,
  ): Promise<HookResponse> {
    const bus = this.busLookup(sessionId);
    if (!bus) {
      log.warn("no bus for session", { sessionId, event });
      return {};
    }

    switch (event) {
      case "PermissionRequest":
        return this.handlePermissionRequest(bus, payload as PermissionRequestPayload);
    }
  }

  private async handlePermissionRequest(
    bus: SessionBus,
    payload: PermissionRequestPayload,
  ): Promise<HookResponse> {
    const toolUseId = synthesizeToolUseId(payload);

    bus.push({
      kind: "approval_request",
      sessionId: bus.sessionId,
      timestamp: new Date().toISOString(),
      toolUseId,
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
    });

    return await new Promise<HookResponse>((resolve) => {
      this.pendingApprovals.set(approvalKey(bus.sessionId, toolUseId), resolve);
    });
  }
}

function approvalKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}:${toolUseId}`;
}

function synthesizeToolUseId(payload: PermissionRequestPayload): string {
  const input = JSON.stringify(payload.tool_input ?? null);
  return `pr:${payload.tool_name}:${hashString(input)}`;
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks as readonly Uint8Array[]).toString("utf8")));
    req.on("error", reject);
  });
}
