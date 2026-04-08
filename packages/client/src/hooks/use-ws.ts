import { type ConnectionState, wsService } from "@/services/ws.service";
import type { WsMessage, WsMessageType } from "common/types";
import { useEffect, useRef, useSyncExternalStore } from "react";

function getWsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
}

export function useWsConnection(): void {
    useEffect(() => {
        wsService.connect(getWsUrl());
        return () => wsService.disconnect();
    }, []);
}

export function useWsState(): ConnectionState {
    return useSyncExternalStore(
        (cb) => wsService.onStateChange(cb),
        () => wsService.state,
    );
}

export function useWsMessage(
    type: WsMessageType | "*",
    handler: (msg: WsMessage) => void,
): void {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        return wsService.on(type, (msg) => handlerRef.current(msg));
    }, [type]);
}

export function useWsSend(): (msg: WsMessage) => void {
    return (msg: WsMessage) => wsService.send(msg);
}
