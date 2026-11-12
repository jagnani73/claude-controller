import type { ClientMessage, ServerMessage } from "common/types";

export type ConnectionState = "connecting" | "connected" | "disconnected";

type AnyHandler = (msg: ServerMessage) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/**
 * Heartbeat. Browsers answer the server's protocol pings without telling the
 * page, so the page probes on its own: a `ping` every interval, and a socket
 * that has delivered nothing (not even the `pong`) for `STALE_AFTER_MS` is
 * treated as dead. After sleep or a network switch the old socket can sit
 * half-open, still OPEN to the browser, for minutes.
 */
const PING_INTERVAL_MS = 20_000;
const STALE_AFTER_MS = 45_000;
/** On returning to the page, how long the probe may take before we reconnect. */
const RESUME_PROBE_MS = 4_000;
/**
 * How long a socket may sit in CONNECTING. A connect that never settles (no
 * open, no error, no close: a dead route, a captive portal) would otherwise
 * leave the state "connecting" for good, and `checkLiveness` skips that state.
 */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long an unacknowledged card response is kept for re-sending. */
const RESPONSE_RESEND_TTL_MS = 10 * 60_000;

/**
 * Called once a message has actually been written to an OPEN socket, with that
 * socket's generation (see `WsService.socketGeneration`).
 */
export type OnWritten = (generation: number) => void;

/** A card response kept until its outcome is known; see `sendResponse`. */
interface UnackedResponse {
  msg: ClientMessage;
  storedAt: number;
  /** Generation of the socket it was last written to; null if never written. */
  sentGen: number | null;
  /** Written again on a later socket after a first write (a re-send). */
  resent: boolean;
}

/** How often kept card responses are checked against the TTL. */
const RESPONSE_PRUNE_INTERVAL_MS = 60_000;

class WsService {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<AnyHandler>>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string | null = null;
  private disposed = false;
  /**
   * Outbound messages queued while the socket isn't yet OPEN. Without this,
   * a `subscribe` fired from a route-mount useEffect on cold start gets
   * silently dropped because the connection is still in CONNECTING state.
   */
  private outboundQueue: { msg: ClientMessage; onWritten?: OnWritten }[] = [];
  /** Card responses (approval / question / plan) awaiting their outcome, by tool-use id. */
  private unackedResponses = new Map<string, UnackedResponse>();
  /** Ages kept responses out while any exist, even with no reconnect to prune them. */
  private responsePruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped on every successful open; identifies which socket a write went to. */
  private generation = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  // Cap so a never-opening socket (backend down at boot) can't grow this
  // unboundedly as the user clicks around.
  private static readonly OUTBOUND_QUEUE_LIMIT = 200;
  /**
   * Some server messages are *stateful* (`connected` carries sessions+workDir)
   * and only fire once per WS lifetime. We cache the latest of each sticky
   * type so a newly-mounted subscriber gets the current state immediately.
   */
  private stickyMessages = new Map<string, ServerMessage>();
  private static readonly STICKY_TYPES: ReadonlySet<string> = new Set([
    "connected",
    "model_catalog",
  ]);

  /** Successful opens so far; every one after the first is a reconnect. */
  private opens = 0;
  private reconnectListeners = new Set<() => void>();
  /** When the current socket last delivered anything. */
  private lastMessageAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleBound = false;

  state: ConnectionState = "disconnected";

  /**
   * Generation of the current (or last) open socket. A write tagged with an
   * older generation went out on a socket that has since been replaced, so
   * whatever it carried may have died with that socket.
   */
  get socketGeneration(): number {
    return this.generation;
  }

  connect(url: string): void {
    if (this.ws || this.state === "connecting") return;
    this.url = url;
    this.disposed = false;
    this.bindLifecycle();
    this.doConnect();
  }

  /**
   * Run `handler` after every reconnect (not the first open). The backend keeps
   * no per-client state across connections, so whatever a view had subscribed
   * to must be asked for again here.
   */
  onReconnect(handler: () => void): () => void {
    this.reconnectListeners.add(handler);
    return () => this.reconnectListeners.delete(handler);
  }

  /**
   * Coming back to the page (or the network) is exactly when the socket is
   * likely to be dead without the browser knowing. Reconnect at once if it is
   * closed (skipping any backoff wait), otherwise probe it and reconnect if the
   * probe goes unanswered.
   */
  private bindLifecycle(): void {
    if (this.lifecycleBound || typeof window === "undefined") return;
    this.lifecycleBound = true;
    const check = () => {
      if (document.visibilityState === "visible") this.checkLiveness();
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    window.addEventListener("pageshow", check);
  }

  private checkLiveness(): void {
    if (this.disposed || !this.url) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (this.state !== "connecting") this.reconnectNow();
      return;
    }
    if (this.probeTimer) return;
    const sentAt = Date.now();
    ws.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.ws === ws && this.lastMessageAt < sentAt) this.dropSocket(ws);
    }, RESUME_PROBE_MS);
  }

  /** Skip the backoff wait and connect now. */
  private reconnectNow(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.doConnect();
  }

  /**
   * Abandon a socket believed dead and reconnect straight away. Its handlers are
   * detached first: `close()` on a half-open socket waits on a closing handshake
   * that never comes, so its `onclose` could fire much later, or never.
   */
  private dropSocket(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closing; nothing to do.
    }
    if (this.ws === ws) this.ws = null;
    this.stopHeartbeat();
    this.setState("disconnected");
    this.reconnectNow();
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return;
      if (Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
        this.dropSocket(ws);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }

  disconnect(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.clearConnectTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  /**
   * Send now if the socket is OPEN, otherwise buffer until the next open.
   * `onWritten` fires when the message is actually written (at once, or at the
   * flush), with the generation of the socket it went out on.
   */
  send(msg: ClientMessage, onWritten?: OnWritten): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      onWritten?.(this.generation);
      return;
    }
    // Coalesce repeated subscribes to the same id — common when a route
    // mount/unmount cycle fires multiple subscribes before the WS opens.
    if (msg.type === "subscribe") {
      const last = this.outboundQueue[this.outboundQueue.length - 1]?.msg;
      if (last && last.type === "subscribe" && last.sessionId === msg.sessionId) {
        this.outboundQueue[this.outboundQueue.length - 1] = { msg, onWritten };
        return;
      }
    }
    this.outboundQueue.push({ msg, onWritten });
    // Over the cap, drop the oldest message that is not a prompt: a dropped
    // `input` would leave its queue item "sending" with nothing ever sent.
    while (this.outboundQueue.length > WsService.OUTBOUND_QUEUE_LIMIT) {
      const idx = this.outboundQueue.findIndex((entry) => entry.msg.type !== "input");
      if (idx === -1) break;
      this.outboundQueue.splice(idx, 1);
    }
  }

  /**
   * Send a card response (approval / question / plan answer) and keep it until
   * `settleResponse(key)` says its outcome arrived. A half-open socket looks
   * OPEN and swallows writes silently, and the card has already locked, so the
   * response is written again on the next socket that opens. Safe to repeat:
   * the backend ignores a repeat approval it already resolved, and answers a
   * question or plan call at most once (`Session.claimAnswer`).
   */
  sendResponse(key: string, msg: ClientMessage): void {
    const entry: UnackedResponse = { msg, storedAt: Date.now(), sentGen: null, resent: false };
    this.unackedResponses.set(key, entry);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      entry.sentGen = this.generation;
    }
    if (!this.responsePruneTimer) {
      this.responsePruneTimer = setInterval(
        () => this.pruneResponses(),
        RESPONSE_PRUNE_INTERVAL_MS,
      );
    }
  }

  /** The outcome of the response stored under `key` arrived; stop re-sending it. */
  settleResponse(key: string): void {
    this.unackedResponses.delete(key);
  }

  /**
   * Stop re-sending every question / plan answer for `sessionId`: its PTY is
   * gone, so the call it answered can never be answered (a resumed CLI starts
   * with no picker open). Approval responses are settled by their cards' expiry.
   */
  settleSessionAnswers(sessionId: string): void {
    for (const [key, entry] of this.unackedResponses) {
      const { msg } = entry;
      if (
        (msg.type === "question_response" || msg.type === "plan_response") &&
        msg.sessionId === sessionId
      ) {
        this.unackedResponses.delete(key);
      }
    }
  }

  /** Drop kept responses past the TTL; stop the timer once none are left. */
  private pruneResponses(): void {
    const now = Date.now();
    for (const [key, entry] of this.unackedResponses) {
      if (now - entry.storedAt > RESPONSE_RESEND_TTL_MS) this.unackedResponses.delete(key);
    }
    if (this.unackedResponses.size === 0 && this.responsePruneTimer) {
      clearInterval(this.responsePruneTimer);
      this.responsePruneTimer = null;
    }
  }

  /** Write every kept response not already written to the socket that just opened. */
  private resendResponses(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.pruneResponses();
    for (const entry of this.unackedResponses.values()) {
      if (entry.sentGen === this.generation) continue;
      if (entry.sentGen !== null) entry.resent = true;
      ws.send(JSON.stringify(entry.msg));
      entry.sentGen = this.generation;
    }
  }

  /**
   * An `approval_expired` error answering a *re-send* says nothing about the
   * decision: the first write most likely arrived and was resolved, and the
   * backend just no longer remembers it (`dev:backend` restarts on every save,
   * emptying its answered-approval memory). Showing it would flip a delivered
   * decision to "Not delivered" and toast. Swallow it and stop re-sending. If
   * the first write really was lost, the call's own result (a hook failure or
   * timeout) still reaches the card through the transcript.
   */
  private isStaleApprovalExpiry(msg: ServerMessage): boolean {
    if (msg.type !== "error" || msg.code !== "approval_expired") return false;
    const entry = this.unackedResponses.get(msg.toolUseId);
    if (!entry?.resent) return false;
    this.unackedResponses.delete(msg.toolUseId);
    return true;
  }

  private flushOutbound(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const queued = this.outboundQueue;
    this.outboundQueue = [];
    for (const { msg, onWritten } of queued) {
      this.ws.send(JSON.stringify(msg));
      onWritten?.(this.generation);
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  on(type: ServerMessage["type"] | "*", handler: AnyHandler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);

    // Replay sticky state to late subscribers so re-mounted views see it.
    if (type !== "*") {
      const cached = this.stickyMessages.get(type);
      if (cached) queueMicrotask(() => handler(cached));
    }

    return () => this.listeners.get(type)?.delete(handler);
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  private doConnect(): void {
    if (!this.url || this.disposed) return;

    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (ws.readyState !== WebSocket.CONNECTING) return;
      // Abandon it like a dead socket: detach first so a late event from it
      // cannot touch the state of the attempt that replaces it.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Nothing to do.
      }
      this.setState("disconnected");
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      this.clearConnectTimer();
      this.ws = ws;
      this.generation++;
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.startHeartbeat(ws);
      this.setState("connected");
      // Buffered messages first (in order), then card responses the previous
      // socket may have swallowed, then the views re-subscribe.
      this.flushOutbound();
      this.resendResponses();
      this.opens++;
      if (this.opens > 1) {
        for (const handler of this.reconnectListeners) handler();
      }
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.emit(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      this.clearConnectTimer();
      this.ws = null;
      this.stopHeartbeat();
      this.setState("disconnected");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private emit(msg: ServerMessage): void {
    if (this.isStaleApprovalExpiry(msg)) return;
    if (WsService.STICKY_TYPES.has(msg.type)) {
      this.stickyMessages.set(msg.type, msg);
    }
    const typeHandlers = this.listeners.get(msg.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) handler(msg);
    }
    const wildcardHandlers = this.listeners.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) handler(msg);
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const handler of this.stateListeners) handler(state);
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }
}

export const wsService = new WsService();
