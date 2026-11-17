import type { WorkflowRun } from "common/workflow-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { wsService } from "@/services/ws.service";
import { useWsMessage } from "./use-ws";
import { nextRequestAction } from "./workflow-request";

/** How often the visible panel and its closed strip ask for fresh snapshots. */
const POLL_INTERVAL_MS = 2000;
const STRIP_POLL_INTERVAL_MS = 10_000;
/** A request with no reply in this long is treated as failed, so the UI can retry. */
const REQUEST_TIMEOUT_MS = 8000;

export interface UseWorkflows {
  runs: readonly WorkflowRun[];
  truncated: boolean;
  /** Nothing has been asked for yet, or the first answer has not arrived. */
  loading: boolean;
  /** A message to show in place of the list; cleared by the next success. */
  error: string | null;
  /** Ask now (and re-arm polling). */
  refresh: () => void;
}

const newRequestId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "").slice(0, 24)
    : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * The workflow runs of one session.
 *
 * **This hook has exactly one owner** (the view, which passes its value to the
 * panel as props). Snapshots are pull-only and the backend serves one per socket
 * at a time, dropping a second request inside its minimum gap — so a second
 * instance of this hook polling the same session would make the two silently
 * starve each other.
 *
 * When it asks:
 *  - once per subscription, on `history_available` (mount, reconnect, resume).
 *    That is the first moment the session is attached, so the strip above the
 *    input has data as soon as the session is attached;
 *  - on a visible tab, every `POLL_INTERVAL_MS` while the panel is open,
 *    otherwise every `STRIP_POLL_INTERVAL_MS` to keep the strip fresh.
 *
 * Every request carries a `requestId` and a reply is applied only when it
 * matches the question in flight, so a slow answer to an older question can
 * never overwrite a newer one. A request in flight is never doubled.
 *
 * The runs are keyed by the session they belong to, so switching chats drops the
 * previous session's runs instead of showing them under the new one.
 */
export function useWorkflows(sessionId: string, active: boolean): UseWorkflows {
  const [state, setState] = useState<{
    sessionId: string;
    runs: WorkflowRun[];
    truncated: boolean;
    loaded: boolean;
    error: string | null;
  }>({ sessionId, runs: [], truncated: false, loaded: false, error: null });
  /** The request awaiting a reply, if any. Cleared on its answer or its timeout. */
  const pending = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** A request waiting for the backend's minimum gap to open. */
  const deferred = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the last request was written; the spacing guard reads it. */
  const lastSentAt = useRef(0);
  /** Only the socket whose session subscription has completed may poll. */
  const attachedGeneration = useRef<number | null>(null);
  /** The latest `request`, for the deferred timer (which outlives one render). */
  const requestRef = useRef<() => void>(() => {});

  const clearPending = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);

  const clearDeferred = useCallback(() => {
    if (!deferred.current) return;
    clearTimeout(deferred.current);
    deferred.current = null;
  }, []);

  const request = useCallback(() => {
    // Never queue stale polls onto a later socket, or poll a hidden page.
    if (
      document.visibilityState !== "visible" ||
      wsService.state !== "connected" ||
      attachedGeneration.current !== wsService.socketGeneration
    )
      return;
    // One request at a time, and never inside the backend's own gap: it drops
    // both silently, so a doubled or too-early request would leave the panel on a
    // stale list with nothing to retry from.
    const action = nextRequestAction({
      hasPending: pending.current !== null,
      lastSentAt: lastSentAt.current,
      now: Date.now(),
    });
    if (action.kind === "hold") return;
    if (action.kind === "defer") {
      // Ask as soon as the gap opens rather than send a request that would be
      // discarded with no reply.
      if (!deferred.current) {
        deferred.current = setTimeout(() => {
          deferred.current = null;
          requestRef.current();
        }, action.ms);
      }
      return;
    }
    const id = newRequestId();
    const timer = setTimeout(() => {
      if (pending.current?.id !== id) return;
      pending.current = null;
      setState((prev) =>
        prev.sessionId === sessionId
          ? { ...prev, error: "Couldn't reach the backend for this session's workflow runs." }
          : prev,
      );
    }, REQUEST_TIMEOUT_MS);
    pending.current = { id, timer };
    lastSentAt.current = Date.now();
    if (!wsService.sendImmediate({ type: "workflows_request", sessionId, requestId: id })) {
      clearTimeout(timer);
      pending.current = null;
      setState((prev) =>
        prev.sessionId === sessionId
          ? { ...prev, error: "Couldn't reach the backend for this session's workflow runs." }
          : prev,
      );
    }
  }, [sessionId]);
  requestRef.current = request;

  // Drop anything belonging to a session we are no longer viewing, and forget
  // the in-flight request with it: its reply must not land on the new session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger, not a value read in the body
  useEffect(() => {
    clearPending();
    clearDeferred();
    lastSentAt.current = 0;
    attachedGeneration.current = null;
    setState({ sessionId, runs: [], truncated: false, loaded: false, error: null });
  }, [sessionId]);

  /**
   * A subscribe (mount, reconnect, resume) replays the tail and ends with
   * `history_available` — the one moment we know this session is attached, and
   * therefore the only safe moment to ask before the panel opens. Asking on
   * mount or on `onReconnect` instead races the subscribe and is refused
   * ("Subscribe to a live session first.").
   */
  useWsMessage("history_available", (msg) => {
    // Agent streams replay under their own composite id; they are not a
    // subscription to this session's runs.
    if (msg.sessionId !== sessionId) return;
    // A reply still in flight belonged to the previous socket/subscription.
    clearPending();
    attachedGeneration.current = wsService.socketGeneration;
    request();
  });

  useWsMessage("workflows_snapshot", (msg) => {
    if (msg.sessionId !== sessionId) return;
    // Only the answer to the question currently in flight is applied.
    if (!pending.current || pending.current.id !== msg.requestId) return;
    clearTimeout(pending.current.timer);
    pending.current = null;
    if (msg.error) {
      // Keep whatever is already on screen: a transient read failure should not
      // blank a list the user is reading. The error banner offers a retry.
      setState((prev) =>
        prev.sessionId === sessionId ? { ...prev, error: msg.error ?? null } : prev,
      );
      return;
    }
    setState({
      sessionId,
      runs: msg.runs,
      truncated: msg.truncated,
      loaded: true,
      error: null,
    });
  });

  useEffect(
    () =>
      wsService.onStateChange((connection) => {
        if (connection === "connected") return;
        attachedGeneration.current = null;
        clearPending();
        clearDeferred();
        setState((prev) =>
          prev.sessionId === sessionId
            ? {
                ...prev,
                error: "Disconnected. Workflow data will refresh after the session reconnects.",
              }
            : prev,
        );
      }),
    [clearPending, clearDeferred, sessionId],
  );

  // One poller serves both panel and strip; changing cadence leaves an in-flight
  // request intact. Hidden tabs do not poll, including a deferred poll.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") request();
      else clearDeferred();
    };
    tick();
    const interval = setInterval(tick, active ? POLL_INTERVAL_MS : STRIP_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, request, clearDeferred]);

  useEffect(
    () => () => {
      clearPending();
      clearDeferred();
    },
    [clearPending, clearDeferred],
  );

  const refresh = useCallback(() => {
    // A Retry must not wait behind a request that may never be answered, so the
    // pending one is dropped. The spacing guard is kept: the backend still drops
    // a request inside its gap, so an early retry is deferred, not discarded.
    clearPending();
    clearDeferred();
    const unavailable =
      wsService.state !== "connected"
        ? "Disconnected. Workflow data will refresh after the session reconnects."
        : attachedGeneration.current !== wsService.socketGeneration
          ? "Waiting for the session subscription. Resume the session if it is stopped."
          : document.visibilityState !== "visible"
            ? "Workflow data will refresh when this page is visible."
            : null;
    setState((prev) =>
      prev.sessionId === sessionId ? { ...prev, error: unavailable ?? prev.error } : prev,
    );
    // Keep an existing error until a successful reply, including while a retry
    // is deferred by the request spacing guard.
    if (!unavailable) request();
  }, [clearPending, clearDeferred, request, sessionId]);

  return {
    // Never hand back another session's runs, even for a render that happens
    // between the route change and the reset effect above.
    runs: state.sessionId === sessionId ? state.runs : [],
    truncated: state.sessionId === sessionId ? state.truncated : false,
    loading: state.sessionId === sessionId ? !state.loaded && !state.error : true,
    error: state.sessionId === sessionId ? state.error : null,
    refresh,
  };
}
