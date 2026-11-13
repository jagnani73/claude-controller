import type { ServerMessage } from "common/types";
import { wsService } from "./ws.service";

type Full = Extract<ServerMessage, { type: "tool_result_full" }>["outcome"];
// Coalesce simultaneous opens; successful values live in the mounted card, not a
// global unbounded cache. Closing/reopening that card does not fetch again.
const pending = new Map<string, Promise<Full>>();
export function fetchToolResult(sessionId: string, toolUseId: string): Promise<Full> {
  const key = JSON.stringify([sessionId, toolUseId]);
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = new Promise<Full>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let sentGeneration = -1;
    const send = () => {
      if (wsService.state !== "connected" || sentGeneration === wsService.socketGeneration) return;
      sentGeneration = wsService.socketGeneration;
      wsService.send({ type: "fetch_tool_result", sessionId, toolUseId, requestId });
    };
    const offMessage = wsService.on("tool_result_full", (msg) => {
      if (
        msg.type !== "tool_result_full" ||
        msg.requestId !== requestId ||
        msg.sessionId !== sessionId ||
        msg.toolUseId !== toolUseId
      )
        return;
      cleanup();
      resolve(msg.outcome);
    });
    const offState = wsService.onStateChange((state) => {
      if (state === "connected") send();
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Result request timed out. Reconnect and retry."));
    }, 30_000);
    function cleanup() {
      clearTimeout(timer);
      offMessage();
      offState();
    }
    send();
  });
  pending.set(key, promise);
  void promise.finally(() => pending.delete(key)).catch(() => {});
  return promise;
}
