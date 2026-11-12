import { Link, useParams } from "@tanstack/react-router";
import { Loader2, SearchX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentsSheet } from "@/components/agents/AgentsSheet";
import { AgentsStrip } from "@/components/agents/AgentsStrip";
import { InputBar, type InputBarHandle } from "@/components/layout/InputBar";
import { type QueueItem, QueuePanel } from "@/components/layout/QueuePanel";
import { SessionTopBar } from "@/components/layout/SessionTopBar";
import { SidebarToggle } from "@/components/layout/SidebarToggle";
import { StatusLine } from "@/components/layout/StatusLine";
import { MessageStream } from "@/components/messages/MessageStream";
import { parseTeammateText } from "@/components/messages/teammate-message";
import { SessionSettingsPopover } from "@/components/sessions/SessionSettingsPopover";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAgents } from "@/hooks/use-agents";
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
  /**
   * "Send now" was requested for this pending item: it sits at the head of
   * the pending queue and is dispatched as soon as the interrupt it asked for
   * ends the active send (see `handleSendNow`). At most one item has it.
   */
  sendNow?: boolean;
}

/**
 * The user entry Claude Code writes to the transcript when a turn is Esc'd
 * (`[Request interrupted by user]`, `… for tool use]`). It reaches us as a
 * `user_prompt` but is the CLI's marker, not something this viewer sent.
 * Observed live on 2.1.322: it lands ~100ms *after* the bus `interrupt` echo,
 * i.e. after a send-now has already put its item in flight.
 */
function isInterruptMarker(text: string): boolean {
  return text.startsWith("[Request interrupted by user");
}

/**
 * Per-session queue state, kept outside the component so switching chats does
 * not throw away prompts the user queued: the queue is their only record.
 *
 * Items stay pending while their session is not on screen and are dispatched
 * when the user returns to it. Dispatching in the background would need a
 * turn-end signal for a session this client is not subscribed to, and the
 * backend streams only the subscribed one.
 */
interface StoredQueue {
  items: InternalQueueItem[];
  /** turnIds already counted — first occurrence per id signals a turn boundary. */
  seenTurnIds: Set<string>;
  /**
   * Latest timestamp of a prompt/reply/interrupt the queue logic processed. On a
   * re-subscribe the backend replays the tail of the log, and anything at or
   * before this mark was already acted on.
   */
  lastSeenAt: string | null;
}

const queueStore = new Map<string, StoredQueue>();

function storedQueue(sessionId: string): StoredQueue {
  let stored = queueStore.get(sessionId);
  if (!stored) {
    stored = { items: [], seenTurnIds: new Set(), lastSeenAt: null };
    queueStore.set(sessionId, stored);
  }
  return stored;
}

/** A replay in progress after a re-subscribe; see `beginReplay`. */
interface ReplayState {
  watermark: string | null;
  /** A replayed event newer than the watermark arrived. */
  sawActivity: boolean;
  /** The re-subscribe followed a reconnect, so an in-flight send may be lost. */
  reconnect: boolean;
}

function isNotRunning(status: string | undefined): boolean {
  return status === "stopped" || status === "error";
}

function hasActiveSend(queue: readonly InternalQueueItem[]): boolean {
  return queue.some((it) => it.status === "in-flight" || it.status === "bus-acked");
}

/**
 * Move the pending item `id` to the head of the pending items, flagged
 * `sendNow` (any earlier flag is cleared). Active items keep their place and
 * the other pending items keep their relative order.
 */
function promoteToHead(queue: readonly InternalQueueItem[], id: string): InternalQueueItem[] {
  const target = queue.find((it) => it.id === id && it.status === "pending");
  if (!target) return [...queue];
  const rest = queue
    .filter((it) => it !== target)
    .map((it) => (it.sendNow ? { ...it, sendNow: false } : it));
  const firstPending = rest.findIndex((it) => it.status === "pending");
  const at = firstPending === -1 ? rest.length : firstPending;
  return [...rest.slice(0, at), { ...target, sendNow: true }, ...rest.slice(at)];
}

export function SessionView() {
  const { sessionId } = useParams({ from: "/session/$sessionId" });
  const { sessions, subscribe, updateSettings, submitInput } = useSessions();
  const { browse } = useWorkspace();
  const [takenOver, setTakenOver] = useState(false);
  const [notFound, setNotFound] = useState(false);
  /** The backend refused input because no PTY is running, or a reconnect found it stopped. */
  const [stoppedHint, setStoppedHint] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("");
  const [recallText, setRecallText] = useState<string | null>(null);
  const [queue, setQueue] = useState<readonly InternalQueueItem[]>(
    () => storedQueue(sessionId).items,
  );
  // Declared before the subscribe effect below so its per-session reset runs
  // first and the snapshot that subscribing triggers is not wiped.
  const { agents, messages: agentMessages } = useAgents(sessionId);
  const [agentsOpen, setAgentsOpen] = useState(false);

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
  const queueRef = useRef<InternalQueueItem[]>(storedQueue(sessionId).items);
  /** turnIds already counted — first-occurrence per id signals turn boundary. */
  const seenTurnIds = useRef<Set<string>>(storedQueue(sessionId).seenTurnIds);
  /** Set while a re-subscribe's replay is arriving; cleared by `history_available`. */
  const replayRef = useRef<ReplayState | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  /**
   * Esc spam gate. After firing a WS interrupt we disarm until the next
   * user_prompt re-arms — without this, repeated Esc presses stack multiple
   * "Interrupted" bubbles (the bus echoes one bubble per WS interrupt).
   */
  const interruptArmedRef = useRef(true);
  /** Imperative handle to push a queued item's text back into the input bar. */
  const inputBarRef = useRef<InputBarHandle>(null);

  const session = sessions.find((s) => s.id === sessionId);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const stopped = isNotRunning(session?.status) || (stoppedHint && !resuming);
  const stoppedRef = useRef(stopped);
  stoppedRef.current = stopped;
  const takenOverRef = useRef(takenOver);
  takenOverRef.current = takenOver;
  const notFoundRef = useRef(notFound);
  notFoundRef.current = notFound;

  /**
   * Push a new state for the queue: mirror to the ref, then re-render via
   * setQueue. The ref is the source of truth; React state is just a view of it.
   */
  const writeQueue = useCallback((next: InternalQueueItem[]) => {
    queueRef.current = next;
    storedQueue(sessionIdRef.current).items = next;
    setQueue(next);
  }, []);

  /**
   * Whether a prompt/reply/interrupt event should drive the queue. A replayed
   * event at or before the watermark was handled before; anything newer happened
   * while this view was away (or the socket was down) and is processed in order.
   */
  const takeQueueEvent = useCallback((timestamp: string): boolean => {
    const stored = storedQueue(sessionIdRef.current);
    const replay = replayRef.current;
    if (replay?.watermark && timestamp <= replay.watermark) return false;
    if (replay) replay.sawActivity = true;
    if (!stored.lastSeenAt || timestamp > stored.lastSeenAt) stored.lastSeenAt = timestamp;
    return true;
  }, []);

  /** A (re-)subscribe is about to replay the tail of this session's log. */
  const beginReplay = useCallback((reconnect: boolean) => {
    replayRef.current = {
      watermark: storedQueue(sessionIdRef.current).lastSeenAt,
      sawActivity: false,
      reconnect,
    };
  }, []);

  /**
   * If nothing is currently in-flight or bus-acked, mark the first pending
   * item as in-flight and fire the WS send. Returns the (possibly mutated)
   * next state but does NOT call setQueue — caller is responsible for that
   * so we don't trigger multiple re-renders per event.
   */
  const dispatchHeadIfIdle = useCallback((current: InternalQueueItem[]): InternalQueueItem[] => {
    if (hasActiveSend(current)) return current;
    const idx = current.findIndex((it) => it.status === "pending");
    if (idx === -1) return current;
    const target = sessionRef.current;
    if (!target) return current;
    // A stopped session would only bounce it back; it waits for Resume.
    if (stoppedRef.current) return current;
    const head = current[idx];
    const next = [...current];
    next[idx] = { ...head, status: "in-flight", sendNow: false };
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
  }, []);

  /**
   * Send the interrupt a pending send-now is waiting on, once the active item
   * is bus-acked (the backend only interrupts a turn whose user_prompt it has
   * seen). Shares the Esc arming gate: if an interrupt is already out (Esc was
   * pressed, or a previous send-now fired), its echo will dispatch the
   * promoted item, so a second one is never sent.
   */
  const fireSendNowInterrupt = useCallback(() => {
    if (!queueRef.current.some((it) => it.status === "bus-acked")) return;
    if (!interruptArmedRef.current) return;
    interruptArmedRef.current = false;
    wsService.send({ type: "interrupt", sessionId });
  }, [sessionId]);

  useEffect(() => {
    setTakenOver(false);
    setNotFound(false);
    setStoppedHint(false);
    setResuming(false);
    setSubscribeError(null);
    setStatusLine("");
    setRecallText(null);
    // This session's own queue, as it was left (see `queueStore`).
    const stored = storedQueue(sessionId);
    queueRef.current = stored.items;
    setQueue(stored.items);
    seenTurnIds.current = stored.seenTurnIds;
    interruptArmedRef.current = true;
    setAgentsOpen(false);
    beginReplay(false);
    subscribe(sessionId);
    return () => {
      wsService.send({ type: "unsubscribe", sessionId });
    };
  }, [sessionId, subscribe, beginReplay]);

  // The backend keeps nothing per client across connections: after a sleep, a
  // network switch or a backend restart this view must subscribe again or it
  // receives nothing. MessageStream drops the replayed tail it already shows.
  // A session known to be stopped is not resubscribed (that would resume it);
  // it shows its Resume action instead.
  useEffect(() => {
    return wsService.onReconnect(() => {
      if (takenOverRef.current || notFoundRef.current) return;
      if (stoppedRef.current) {
        setStoppedHint(true);
        return;
      }
      beginReplay(true);
      subscribe(sessionId);
    });
  }, [sessionId, subscribe, beginReplay]);

  useWsMessage("history_available", (msg) => {
    if (msg.sessionId !== sessionId) return;
    const replay = replayRef.current;
    replayRef.current = null;
    // After a reconnect with nothing new in the replay, an in-flight send most
    // likely died with the old socket: put it back and send it again.
    if (replay?.reconnect && !replay.sawActivity) {
      const reverted = queueRef.current.map((it) =>
        it.status === "in-flight" ? { ...it, status: "pending" as const } : it,
      );
      writeQueue(dispatchHeadIfIdle(reverted));
    }
  });

  useWsMessage("session_metadata", (msg) => {
    if (msg.session.id !== sessionId || isNotRunning(msg.session.status)) return;
    setStoppedHint(false);
    setResuming(false);
    setSubscribeError(null);
  });

  useWsMessage("session_taken_over", (msg) => {
    if (msg.sessionId === sessionId) setTakenOver(true);
  });

  useWsMessage("status_line", (msg) => {
    if (msg.sessionId === sessionId) setStatusLine(msg.text);
  });

  useWsMessage("user_prompt", (msg) => {
    if (msg.sessionId !== sessionId) return;
    // With agent teams on, a teammate's message reaches the lead as a user turn.
    // It is not something this viewer sent, so it must not acknowledge a queued
    // send or become the text Up-arrow recalls.
    if (parseTeammateText(msg.text)) return;
    // Likewise the CLI's interrupt marker: acking on it would retire a
    // send-now item before its own echo (hiding its preview through the
    // redirect respawn) and re-arm Esc while that respawn is still running.
    if (isInterruptMarker(msg.text)) return;
    if (!msg.text.startsWith("/")) setRecallText(msg.text);
    if (!takeQueueEvent(msg.timestamp)) return;
    // Fresh turn re-arms Esc — the previous interrupt (if any) is over.
    interruptArmedRef.current = true;
    // Bus echoed our send — flip the in-flight item to bus-acked so we
    // stop drawing it from the queue (MessageStream's reducer now owns
    // rendering this bubble).
    const idx = queueRef.current.findIndex((it) => it.status === "in-flight");
    if (idx === -1) return;
    const next = [...queueRef.current];
    next[idx] = { ...next[idx], status: "bus-acked" };
    writeQueue(next);
    // A send-now requested while this item was still in flight deferred its
    // interrupt until now: before the echo the backend has no running turn to
    // interrupt (its idle gate would swallow the event and nothing would
    // dispatch the promoted item).
    if (next.some((it) => it.sendNow)) fireSendNowInterrupt();
  });

  useWsMessage("assistant_text", (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (seenTurnIds.current.has(msg.turnId)) return;
    seenTurnIds.current.add(msg.turnId);
    if (!takeQueueEvent(msg.timestamp)) return;
    // Turn boundary: drop the bus-acked head; dispatch the next pending. In a
    // replay, a reply newer than the watermark also retires an in-flight item:
    // it was sent before the view left, and its echo may be older than the
    // replayed tail.
    const replaying = replayRef.current !== null;
    const cleaned = queueRef.current.filter(
      (it) => it.status !== "bus-acked" && !(replaying && it.status === "in-flight"),
    );
    writeQueue(dispatchHeadIfIdle(cleaned));
  });

  useWsMessage("interrupt", (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (!takeQueueEvent(msg.timestamp)) return;
    // Interrupt ends whatever was in-flight; it is never resent. Pending tail
    // is left alone (the user pressed Esc to stop, not to fast-forward) —
    // unless a send-now asked for this interrupt, in which case its item is the
    // pending head and goes out now as an ordinary `input`. Arriving after the
    // backend logged the interrupt, that input takes Session.sendInput's
    // redirect path (respawn → clean textarea), so the CLI never prepends the
    // interrupted text and exactly one user_prompt carries the promoted text.
    const remaining = queueRef.current.filter((it) => it.status === "pending");
    writeQueue(remaining.some((it) => it.sendNow) ? dispatchHeadIfIdle(remaining) : remaining);
  });

  useWsMessage("error", (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.code === "session_not_found") setNotFound(true);
    if (msg.code === "subscribe_failed") {
      setResuming(false);
      setSubscribeError(msg.message);
    }
    if (msg.code === "session_stopped") {
      // The send reached no CLI. Put it back at the head of the queue, where it
      // waits for Resume instead of hanging as "sending".
      writeQueue(
        queueRef.current.map((it) =>
          it.status === "in-flight" ? { ...it, status: "pending" as const } : it,
        ),
      );
      setResuming(false);
      setStoppedHint(true);
    }
  });

  /** Resume a stopped session: a subscribe takes the backend's `--resume` path. */
  const handleResume = useCallback(() => {
    setResuming(true);
    setSubscribeError(null);
    beginReplay(false);
    subscribe(sessionId);
  }, [sessionId, subscribe, beginReplay]);

  // Hide the chat input while an AskUserQuestion is unanswered — the CLI is
  // waiting on a structured answer, not free text, and two competing input
  // surfaces is confusing. MessageStream owns this signal because its reducer
  // is the only place that correctly reconciles the synthesized approval id
  // with the real tool_use_id.
  const [hasPendingQuestion, setHasPendingQuestion] = useState(false);

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
    .map((it) => ({ id: it.id, text: it.text, sendingNow: it.sendNow === true }));
  const isProcessing = hasActiveSend(queue);
  /** Most recent pending item — Esc pops this back into the input. */
  const queueTail = pendingItems.length > 0 ? pendingItems[pendingItems.length - 1].text : null;

  /**
   * Esc with non-empty queue — remove the most recent pending item; InputBar
   * will fill the textarea with its text so the user can edit/discard.
   */
  const handlePopQueueTail = useCallback(() => {
    const items = queueRef.current;
    // Find the last pending item by walking from the end. We only pop
    // pendings — never an in-flight or bus-acked item (those are already
    // at the backend and can't be unsent).
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].status === "pending") {
        writeQueue([...items.slice(0, i), ...items.slice(i + 1)]);
        return;
      }
    }
  }, [writeQueue]);

  /**
   * Tap a queued row to edit it: remove that pending item and push its text
   * back into the input bar. The QueuePanel only renders pending items, so the
   * id is always poppable.
   */
  const handleEditQueued = useCallback(
    (id: string) => {
      const item = queueRef.current.find((it) => it.id === id && it.status === "pending");
      if (!item) return;
      writeQueue(queueRef.current.filter((it) => it.id !== id));
      inputBarRef.current?.loadDraft(item.text);
    },
    [writeQueue],
  );

  /** Tap × on a queued row to discard it without sending. */
  const handleRemoveQueued = useCallback(
    (id: string) => {
      writeQueue(queueRef.current.filter((it) => !(it.id === id && it.status === "pending")));
    },
    [writeQueue],
  );

  /**
   * Esc with empty queue — interrupt the in-flight turn on the backend.
   * Gated by `interruptArmedRef` so spamming Esc doesn't stack multiple
   * "Interrupted" bubbles (one bus-echoed bubble per WS interrupt).
   */
  const handleInterrupt = useCallback(() => {
    if (!interruptArmedRef.current) return;
    if (!hasActiveSend(queueRef.current)) return;
    interruptArmedRef.current = false;
    wsService.send({ type: "interrupt", sessionId });
  }, [sessionId]);

  /**
   * "Send now" for a pending item: interrupt the current turn and send this
   * item next, ahead of the rest of the queue (whose order is preserved).
   *
   * Sequence: promote to the pending head → WS `interrupt` → wait for the bus
   * `interrupt` echo → the `interrupt` handler dispatches the head as a normal
   * `input`. Waiting for the echo (rather than sending `input` right behind
   * the interrupt) keeps the queue unambiguous — the interrupted item is
   * retired before the promoted one goes in flight, so the next user_prompt
   * echo can only belong to it — and guarantees the backend already logged the
   * interrupt, which is what makes Session.sendInput respawn for a clean
   * textarea. If the turn ends before the interrupt lands (no echo), the
   * normal assistant_text boundary dispatches the head instead.
   *
   * Why not the CLI's own send-now (ctrl+enter / ctrl+x ctrl+s since 2.1.275):
   * that acts on Claude Code's internal queue, which the controller never
   * fills — queued messages live here, on the phone, and only reach the PTY
   * one at a time — and driving it would mean synthesizing keystrokes whose
   * outcome we cannot confirm. Interrupt + redirect is the path the backend
   * already handles (respawn, concat-echo drop).
   */
  const handleSendNow = useCallback(
    (id: string) => {
      const promoted = promoteToHead(queueRef.current, id);
      if (!hasActiveSend(promoted)) {
        // Nothing running from this view's point of view: just send it.
        writeQueue(dispatchHeadIfIdle(promoted));
        return;
      }
      writeQueue(promoted);
      // If the active item is still in flight, the user_prompt handler fires
      // this once it is acked.
      fireSendNowInterrupt();
    },
    [writeQueue, dispatchHeadIfIdle, fireSendNowInterrupt],
  );

  /**
   * Ctrl/Cmd+Enter in the input bar. With text: queue it and send it now. With
   * an empty box: send the oldest queued item now. Slash commands are not
   * queued, so they just go out as usual.
   */
  const handleSubmitNow = useCallback(
    (text: string | null) => {
      if (text === null) {
        const head = queueRef.current.find((it) => it.status === "pending");
        if (head) handleSendNow(head.id);
        return;
      }
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
      queueRef.current = [...queueRef.current, item];
      handleSendNow(item.id);
    },
    [sessionId, submitInput, handleSendNow],
  );

  // Opening a session points the sidebar's shared folder state (WorkspaceContext
  // currentPath) at that session's cwd, so the picker breadcrumbs and "Recent
  // chats" reflect the active project. This intentionally wins over a folder you
  // had browsed to in the sidebar — opening a session re-points it.
  useEffect(() => {
    if (session?.cwd) browse(session.cwd);
  }, [session?.cwd, browse]);

  // Self-heal: an item should only ever be enqueued while `session` is defined
  // (the InputBar is gated on it), but if one ever lands while `session` is
  // momentarily undefined, dispatchHeadIfIdle no-ops (it needs sessionRef) and
  // the head would strand "pending". Re-kick the queue when `session` resolves
  // so a pending head can't get stuck. No-op when nothing is pending or a send
  // is already active.
  useEffect(() => {
    if (session) writeQueue(dispatchHeadIfIdle(queueRef.current));
  }, [session, dispatchHeadIfIdle, writeQueue]);

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
              beginReplay(false);
              subscribe(sessionId);
            }}
          >
            Reclaim here
          </Button>
        </div>
      </div>
    );
  }

  // NB: we intentionally do NOT early-return a loader while `session` is
  // undefined. MessageStream only needs `sessionId`, and the backend's
  // subscribe replay (the tail of the event log) is one-shot — if the stream
  // weren't mounted to receive it, re-opening a session created during this WS
  // connection would drop the replayed transcript and strand the view on a
  // spinner (session_metadata, which defines `session`, arrives *after* the
  // replay). Keeping MessageStream mounted means its WS handlers are always
  // live when the replay arrives: registered before SessionView's subscribe
  // effect on the initial mount (child effects run before the parent's), and
  // still registered from a prior commit when navigating session→session (the
  // subscribe effect re-runs on sessionId change; the stream's handlers don't).
  // Only the top bar + input — which genuinely need `session` — gate on it.
  return (
    <div className="flex h-dvh flex-col">
      {session ? (
        <SessionTopBar session={session} />
      ) : stopped ? (
        <header className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-background/60 px-3 py-2 backdrop-blur">
          <SidebarToggle />
          <span className="font-serif text-base italic text-muted-foreground">Session stopped</span>
        </header>
      ) : (
        <header className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-background/60 px-3 py-2 backdrop-blur">
          <SidebarToggle />
          <Loader2 className="size-4 animate-spin text-accent" />
          <span className="font-serif text-base italic text-muted-foreground">
            Opening session…
          </span>
        </header>
      )}
      <div className="min-h-0 flex-1">
        <MessageStream
          sessionId={sessionId}
          // The plan picker belongs to the running process, not a pending pick.
          model={session?.runningModel ?? session?.model}
          inFlightPreview={
            inFlightItem ? { text: inFlightItem.text, timestamp: inFlightItem.timestamp } : null
          }
          isProcessing={isProcessing}
          onPendingQuestionChange={setHasPendingQuestion}
        />
      </div>
      <div className="relative" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <AgentsStrip agents={agents} onOpen={() => setAgentsOpen(true)} />
        {(stopped || subscribeError) && (
          <div className="flex items-center gap-3 border-t border-border/60 bg-muted/30 px-4 py-2 text-sm">
            <span className="min-w-0 flex-1 text-muted-foreground">
              {subscribeError ??
                (resuming
                  ? "Resuming session…"
                  : `Session stopped${
                      pendingItems.length > 0
                        ? ` · ${pendingItems.length} queued message${pendingItems.length === 1 ? "" : "s"} will send after resuming`
                        : ""
                    }`)}
            </span>
            <Button size="sm" onClick={handleResume} disabled={resuming}>
              {resuming ? "Resuming…" : subscribeError ? "Retry" : "Resume"}
            </Button>
          </div>
        )}
        {session && (
          <>
            <QueuePanel
              queue={pendingItems}
              onEdit={handleEditQueued}
              onRemove={handleRemoveQueued}
              onSendNow={handleSendNow}
            />
            {!hasPendingQuestion && (
              <InputBar
                ref={inputBarRef}
                onSubmit={handleSubmit}
                isProcessing={isProcessing}
                recallText={recallText}
                queueTail={queueTail}
                onPopQueueTail={handlePopQueueTail}
                onInterrupt={handleInterrupt}
                onSubmitNow={handleSubmitNow}
                settingsSlot={
                  <SessionSettingsPopover
                    session={session}
                    onChange={(next) => updateSettings(sessionId, next)}
                  />
                }
              />
            )}
          </>
        )}
        <StatusLine text={statusLine} />
      </div>
      <AgentsSheet
        sessionId={sessionId}
        agents={agents}
        messages={agentMessages}
        open={agentsOpen}
        onOpenChange={setAgentsOpen}
      />
    </div>
  );
}
