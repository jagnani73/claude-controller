import type { ClientMessage, ServerMessage } from "common/types";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { type ConnectionState, wsService } from "@/services/ws.service";

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export function useWsConnection(): void {
  useEffect(() => {
    wsService.connect(getWsUrl());
  }, []);
}

export function useWsState(): ConnectionState {
  return useSyncExternalStore(
    (cb) => wsService.onStateChange(cb),
    () => wsService.state,
  );
}

/** Subscribe to a specific server message type with narrowed payload. */
export function useWsMessage<T extends ServerMessage["type"]>(
  type: T,
  handler: (msg: Extract<ServerMessage, { type: T }>) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return wsService.on(type, (msg) => {
      handlerRef.current(msg as Extract<ServerMessage, { type: T }>);
    });
  }, [type]);
}

export function useWsSend(): (msg: ClientMessage) => void {
  return (msg: ClientMessage) => wsService.send(msg);
}
