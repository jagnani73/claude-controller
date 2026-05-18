import { Link, useParams } from "@tanstack/react-router";
import { Loader2, SearchX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { InputBar } from "@/components/layout/InputBar";
import { QueuePanel, type QueueItem } from "@/components/layout/QueuePanel";
import { SessionTopBar } from "@/components/layout/SessionTopBar";
import { StatusLine } from "@/components/layout/StatusLine";
import { MessageStream } from "@/components/messages/MessageStream";
import { SessionSettingsPopover } from "@/components/sessions/SessionSettingsPopover";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSessions } from "@/hooks/use-sessions";
import { useWsMessage } from "@/hooks/use-ws";
import { useWorkspace } from "@/lib/workspace-context";
import { wsService } from "@/services/ws.service";

/**
 * Per-queue-item lifecycle:
 *   - "pending"   → submitted, not yet sent to backend (something else is
 *                   in-flight or bus-acked). Rendered in QueuePanel.
 *   - "in-flight" → sent to backend, waiting for the bus echo. Rendered in
 *                   MessageStream as a preview bubble (the optimistic part).
 *   - "bus-acked" → bus echoed; MessageStream's reducer owns the canonical
 *                   bubble now, so we stop drawing this item. Kept until
 *                   assistant_text removes it (which also unblocks the next
 *                   pending dispatch).
 */
type QueueStatus = "pending" | "in-flight" | "bus-acked";

interface InternalQueueItem {
  id: string;
  text: string;
  timestamp: string;
  sessionId: string;
  status: QueueStatus;
}

function hasActiveSend(queue: readonly InternalQueueItem[]): boolean {
  return queue.some((it) => it.status === "in-flight" || it.status === "bus-acked");
}

export function SessionView() {
  const { sessionId } = useParams({ from: "/session/$sessionId" });
  const { sessions, subscribe, updateSettings, submitInput } = useSessions();
  const { requestBrowse } = useWorkspace();
  const [takenOver, setTakenOver] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [recallText, setRecallText] = useState<string | null>(null);
  const [queue, setQueue] = useState<readonly InternalQueueItem[]>([]);

  /**
   * Synchronous mirror of the queue state. All mutations go through here
   * first; setQueue just re-renders. Reasons we need this and not just the
   * setState updater pattern:
   *   1. React StrictMode dev double-invokes setState updaters to surface
   *      impurities. Anything with a side effect (like wsService.send)
   *      inside an updater fires twice — that's what was causing
   *      "heyhey" / "whats upwhats up" stitching.
   *   2. Rapid back-to-back submits in the same React batch need to see
   *      each other's mutations synchronously to decide "send now vs.
   *      queue", which functional updaters allow but a plain state read
   *      doesn't.
   *
   * So: mutate queueRef synchronously, decide what to send, fire the side
   * effect, then mirror to setQueue. The updater itself is pure.
   */
  const queueRef = useRef<InternalQueueItem[]>([]);
  /** turnIds already counted — first-occurrence per id signals turn boundary. */
  const seenTurnIds = useRef<Set<string>>(new Set());

  const session = sessions.find((s) => s.id === sessionId);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  /**
   * Push a new state for the queue: mirror to the ref, then re-render via
   * setQueue. The ref is the source of truth; React state is just a view of it.
   */
  const writeQueue = useCallback((next: InternalQueueItem[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);

  /**
   * If nothing is currently in-flight or bus-acked, mark the first pending
   * item as in-flight and fire the WS send. Returns the (possibly mutated)
   * next state but does NOT call setQueue — caller is responsible for that
   * so we don't trigger multiple re-renders per event.
   */
  const dispatchHeadIfIdle = useCallback(
    (current: InternalQueueItem[]): InternalQueueItem[] => {
      if (hasActiveSend(current)) return current;
      const idx = current.findIndex((it) => it.status === "pending");
      if (idx === -1) return current;
      const target = sessionRef.current;
      if (!target) return current;
      const head = current[idx];
      const next = [...current];
      next[idx] = { ...head, status: "in-flight" };
      wsService.send({
        type: "input",
        sessionId: head.sessionId,
        text: head.text,
        settings: {
          model: target.model,
          effort: target.effort,
          permissionMode: target.permissionMode,
        },
      });
      return next;
    },
    [],
  );

  useEffect(() => {
    setTakenOver(false);
    setNotFound(false);
    setStatusLine("");
    setRecallText(null);
    writeQueue([]);
    seenTurnIds.current = new Set();
    subscribe(sessionId);
    return () => {
      wsService.send({ type: "unsubscribe", sessionId });
    };
  }, [sessionId, subscribe, writeQueue]);

  useWsMessage("session_taken_over", (msg) => {
    if (msg.sessionId === sessionId) setTakenOver(true);
  });

  useWsMessage("status_line", (msg) => {
    if (msg.sessionId === sessionId) setStatusLine(msg.text);
  });

  useWsMessage("user_prompt", (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (!msg.text.startsWith("/")) setRecallText(msg.text);
    // Bus echoed our send — flip the in-flight item to bus-acked so we
    // stop drawing it from the queue (MessageStream's reducer now owns
    // rendering this bubble).
    const idx = queueRef.current.findIndex((it) => it.status === "in-flight");
    if (idx === -1) return;
    const next = [...queueRef.current];
    next[idx] = { ...next[idx], status: "bus-acked" };
    writeQueue(next);
  });

  useWsMessage("assistant_text", (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (seenTurnIds.current.has(msg.turnId)) return;
    seenTurnIds.current.add(msg.turnId);
    // Turn boundary: drop the bus-acked head; dispatch the next pending.
    const cleaned = queueRef.current.filter((it) => it.status !== "bus-acked");
    writeQueue(dispatchHeadIfIdle(cleaned));
  });

  useWsMessage("interrupt", (msg) => {
    if (msg.sessionId !== sessionId) return;
    // Interrupt ends whatever was in-flight. Pending tail is left alone
    // (the user pressed Esc to stop, not to fast-forward).
    writeQueue(queueRef.current.filter((it) => it.status === "pending"));
  });

  useWsMessage("error", (msg) => {
    if (msg.sessionId === sessionId && msg.code === "session_not_found") setNotFound(true);
  });

  const handleSubmit = useCallback(
    (text: string) => {
      if (text.startsWith("/")) {
        submitInput(sessionId, text);
        return;
      }
      const item: InternalQueueItem = {
        id: crypto.randomUUID(),
        text,
        timestamp: new Date().toISOString(),
        sessionId,
        status: "pending",
      };
      writeQueue(dispatchHeadIfIdle([...queueRef.current, item]));
    },
    [sessionId, submitInput, dispatchHeadIfIdle, writeQueue],
  );

  const inFlightItem = queue.find((it) => it.status === "in-flight");
  const pendingItems: QueueItem[] = queue
    .filter((it) => it.status === "pending")
    .map((it) => ({ id: it.id, text: it.text }));
  const isProcessing = hasActiveSend(queue);

  useEffect(() => {
    if (session?.cwd) requestBrowse(session.cwd);
  }, [session?.cwd, requestBrowse]);

  if (notFound) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center px-6">
        <EmptyState
          icon={SearchX}
          title="Session not found"
          description={
            <span>
              No transcript exists for{" "}
              <span className="font-mono text-foreground/80">{sessionId.slice(0, 8)}…</span> on this
              backend. It may have been started elsewhere or the id is mistyped.
            </span>
          }
          action={
            <Button asChild>
              <Link to="/">Back to Home</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (takenOver) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="font-serif text-lg text-foreground">Session in use elsewhere</p>
        <p className="max-w-md text-base text-muted-foreground">
          This session was opened on another device. Stream paused here to keep it exclusive.
        </p>
        <div className="flex gap-2">
          <Button variant="default" asChild>
            <Link to="/">Back to Home</Link>
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setTakenOver(false);
              subscribe(sessionId);
            }}
          >
            Reclaim here
          </Button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-accent" />
        <p className="mt-3 font-serif text-base italic">Opening session…</p>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <SessionTopBar session={session} />
      <div className="min-h-0 flex-1">
        <MessageStream
          sessionId={sessionId}
          inFlightPreview={
            inFlightItem ? { text: inFlightItem.text, timestamp: inFlightItem.timestamp } : null
          }
          isProcessing={isProcessing}
        />
      </div>
      <div className="relative" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <QueuePanel queue={pendingItems} />
        <InputBar
          onSubmit={handleSubmit}
          recallText={recallText}
          settingsSlot={
            <SessionSettingsPopover
              session={session}
              onChange={(next) => updateSettings(sessionId, next)}
            />
          }
        />
        <StatusLine text={statusLine} />
      </div>
    </div>
  );
}
