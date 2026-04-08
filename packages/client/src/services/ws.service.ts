import type { WsMessage, WsMessageType } from "common/types";

export type ConnectionState = "connecting" | "connected" | "disconnected";

type MessageHandler = (msg: WsMessage) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class WsService {
    private ws: WebSocket | null = null;
    private listeners = new Map<string, Set<MessageHandler>>();
    private stateListeners = new Set<(state: ConnectionState) => void>();
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private url: string | null = null;
    private disposed = false;

    state: ConnectionState = "disconnected";

    connect(url: string): void {
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

    send(msg: WsMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    on(type: WsMessageType | "*", handler: MessageHandler): () => void {
        const key = type;
        let set = this.listeners.get(key);
        if (!set) {
            set = new Set();
            this.listeners.set(key, set);
        }
        set.add(handler);
        return () => this.listeners.get(key)?.delete(handler);
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
                const msg = JSON.parse(event.data as string) as WsMessage;
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

    private emit(msg: WsMessage): void {
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

        const delay = Math.min(
            RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
            RECONNECT_MAX_MS,
        );
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
    }
}

export const wsService = new WsService();
