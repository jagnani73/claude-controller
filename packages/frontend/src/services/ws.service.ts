import type { ClientMessage, ServerMessage } from "common/types";

export type ConnectionState = "connecting" | "connected" | "disconnected";

type AnyHandler = (msg: ServerMessage) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class WsService {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<AnyHandler>>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string | null = null;
  private disposed = false;
  /**
   * Some server messages are *stateful* (`connected` carries sessions+workDir)
   * and only fire once per WS lifetime. We cache the latest of each sticky
   * type so a newly-mounted subscriber gets the current state immediately.
   */
  private stickyMessages = new Map<string, ServerMessage>();
  private static readonly STICKY_TYPES: ReadonlySet<string> = new Set(["connected"]);

  state: ConnectionState = "disconnected";

  connect(url: string): void {
    if (this.ws || this.state === "connecting") return;
    this.url = url;
    this.disposed = false;
    this.doConnect();
  }

  disconnect(): void {
    this.disposed = true;
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

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
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

    ws.onopen = () => {
      this.ws = ws;
      this.reconnectAttempt = 0;
      this.setState("connected");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.emit(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.setState("disconnected");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private emit(msg: ServerMessage): void {
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
