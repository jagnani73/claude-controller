import type { WorkspaceQuery, WorkspaceResult } from "common/types";
import { useEffect, useState } from "react";
import { useWsState } from "@/hooks/use-ws";
import { wsService } from "@/services/ws.service";

/** One active correlated read. No offline queue, stale replies, or orphan timers. */
export function useWorkspaceRequest<K extends WorkspaceResult["kind"]>(
  sessionId: string,
  query: (WorkspaceQuery & { kind: K }) | null,
  revision = 0,
) {
  const connection = useWsState();
  const encoded = JSON.stringify(query);
  const [attempt, setAttempt] = useState(0);
  const key = `${sessionId}:${encoded}:${revision}:${connection}:${attempt}`;
  const [state, setState] = useState<{
    key: string;
    result?: WorkspaceResult;
    error?: string;
  }>({ key: "" });
  useEffect(() => {
    const parsed = JSON.parse(encoded) as WorkspaceQuery | null;
    if (!parsed) return;
    setState({ key });
    if (connection !== "connected") {
      setState({ key, error: "Disconnected. This view will reload when the connection returns." });
      return;
    }
    const requestId = crypto.randomUUID();
    const generation = wsService.socketGeneration;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setState({ key, error: "Workspace read timed out. Retry." });
    }, 45000);
    const unsubscribe = wsService.on("workspace_response", (message) => {
      if (
        message.type !== "workspace_response" ||
        settled ||
        message.sessionId !== sessionId ||
        message.requestId !== requestId ||
        generation !== wsService.socketGeneration
      ) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (message.ok && message.result.kind === parsed.kind) {
        setState({ key, result: message.result });
      } else {
        setState({ key, error: message.ok ? "Unexpected workspace response." : message.message });
      }
    });
    wsService.send({ type: "workspace_request", requestId, sessionId, query: parsed });
    return () => {
      settled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [sessionId, encoded, connection, key]);
  return {
    result:
      state.key === key
        ? (state.result as Extract<WorkspaceResult, { kind: K }> | undefined)
        : undefined,
    error: state.key === key ? state.error : undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}
