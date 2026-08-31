// Helpers for probes that drive a *running controller* over its WebSocket,
// rather than spawning the CLI directly.
//
// Some contracts only exist end-to-end — a PermissionRequest hook never fires
// under headless `claude -p` (there is nobody to prompt) and did not reproduce
// in a bare PTY either. The only place it reliably fires is a real controller
// session, so those probes need the backend up.

import { backendRequire } from "./env.mjs";

const WebSocket = backendRequire("ws");

export const CONTROLLER_WS = process.env.CONTROLLER_WS || "ws://127.0.0.1:4577";

/**
 * Connect to a running controller. Rejects with actionable guidance rather than
 * a bare ECONNREFUSED, since "backend not started" is the overwhelmingly common
 * cause and the raw error does not say so.
 */
export function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CONTROLLER_WS, { headers: { Origin: "http://localhost:4578" } });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out connecting to ${CONTROLLER_WS}`));
    }, 10000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `could not connect to ${CONTROLLER_WS}: ${err.message}\n` +
            `start the backend first: pnpm dev:backend`,
        ),
      );
    });
  });
}

/**
 * Resolve once the CLI is actually accepting stdin.
 *
 * Deliberately not a fixed delay. An earlier version of this probe sent its
 * prompt 14s after session creation; the CLI does not read stdin until it has
 * booted (~25s+), so the input was swallowed and no transcript was ever
 * written — the run looked like a failed feature rather than a mistimed probe.
 * `status_line` only arrives once Claude Code has booted and rendered, which is
 * the observable moment stdin goes live.
 */
export function waitForReady(ws, sessionId, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CLI never reported a status_line — it may not have booted")),
      timeoutMs,
    );
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "status_line" && (!msg.sessionId || msg.sessionId === sessionId)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        // Small settle after the first render before writing to stdin.
        setTimeout(resolve, 3000);
      }
    };
    ws.on("message", onMessage);
  });
}

/** Create a session and resolve with its id once the controller reports one. */
export function createSession(ws, config, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session was never created")), timeoutMs);
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(new Error(`controller rejected create_session: ${msg.message ?? "(no message)"}`));
        return;
      }
      if ((msg.type === "session_created" || msg.type === "session_metadata") && msg.session?.id) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg.session);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "create_session", config }));
  });
}

export const send = (ws, msg) => ws.send(JSON.stringify(msg));
