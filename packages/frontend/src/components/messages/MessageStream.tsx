import type { ServerMessage } from "common/types";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ApprovalCard } from "@/components/messages/ApprovalCard";
import { AssistantMessage } from "@/components/messages/AssistantMessage";
import { Markdown } from "@/components/messages/Markdown";
import { QuestionCard } from "@/components/messages/QuestionCard";
import { ThinkingIndicator } from "@/components/messages/ThinkingIndicator";
import { ToolCallCard } from "@/components/messages/ToolCallCard";
import { UserMessage } from "@/components/messages/UserMessage";
import { useWsMessage } from "@/hooks/use-ws";
import { wsService } from "@/services/ws.service";

const HISTORY_PAGE_SIZE = 20;

type StreamItem =
  | {
      kind: "user";
      id: string;
      sessionId: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "assistant";
      id: string;
      sessionId: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "tool";
      id: string;
      sessionId: string;
      toolName: string;
      input: unknown;
      result: { value: unknown; isError: boolean } | null;
    }
  | {
      kind: "approval";
      id: string;
      sessionId: string;
      toolName: string;
      toolInput: unknown;
      resolved?: "allow" | "deny";
    }
  | {
      kind: "compact_summary";
      id: string;
      sessionId: string;
      text: string;
      timestamp: string;
    };

type Action =
  | { type: "clear" }
  | {
      type: "user_prompt";
      sessionId: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "assistant_text";
      sessionId: string;
      turnId: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "tool_call";
      sessionId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      sessionId: string;
      toolUseId: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "approval_request";
      sessionId: string;
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
    }
  | {
      type: "approval_resolved";
      toolUseId: string;
      decision: "allow" | "deny";
    }
  | {
      type: "compact_summary";
      sessionId: string;
      text: string;
      timestamp: string;
    }
  | { type: "prepend"; items: StreamItem[] };

function reducer(state: StreamItem[], action: Action): StreamItem[] {
  switch (action.type) {
    case "clear":
      return [];
    case "user_prompt":
      if (
        state.some(
          (it) =>
            it.kind === "user" && it.text === action.text && it.sessionId === action.sessionId,
        )
      ) {
        return state;
      }
      return [
        ...state,
        {
          kind: "user",
          id: `u-${action.timestamp}-${state.length}`,
          sessionId: action.sessionId,
          text: action.text,
          timestamp: action.timestamp,
        },
      ];
    case "assistant_text": {
      const id = `a-${action.turnId}-${state.length}`;
      if (
        state.some(
          (it) =>
            it.kind === "assistant" && it.text === action.text && it.sessionId === action.sessionId,
        )
      ) {
        return state;
      }
      return [
        ...state,
        {
          kind: "assistant",
          id,
          sessionId: action.sessionId,
          text: action.text,
          timestamp: action.timestamp,
        },
      ];
    }
    case "tool_call":
      if (state.some((it) => it.kind === "tool" && it.id === action.toolUseId)) {
        return state;
      }
      return [
        ...state,
        {
          kind: "tool",
          id: action.toolUseId,
          sessionId: action.sessionId,
          toolName: action.toolName,
          input: action.input,
          result: null,
        },
      ];
    case "tool_result":
      return state.map((it) =>
        it.kind === "tool" && it.id === action.toolUseId
          ? { ...it, result: { value: action.result, isError: action.isError } }
          : it,
      );
    case "approval_request":
      if (state.some((it) => it.kind === "approval" && it.id === action.toolUseId)) {
        return state;
      }
      return [
        ...state,
        {
          kind: "approval",
          id: action.toolUseId,
          sessionId: action.sessionId,
          toolName: action.toolName,
          toolInput: action.toolInput,
        },
      ];
    case "approval_resolved":
      return state.map((it) =>
        it.kind === "approval" && it.id === action.toolUseId
          ? { ...it, resolved: action.decision }
          : it,
      );
    case "compact_summary": {
      const id = `c-${action.timestamp}-${state.length}`;
      if (state.some((it) => it.kind === "compact_summary" && it.id === id)) return state;
      return [
        ...state,
        {
          kind: "compact_summary",
          id,
          sessionId: action.sessionId,
          text: action.text,
          timestamp: action.timestamp,
        },
      ];
    }
    case "prepend": {
      // Deduplicate by id — some older messages may already be in the
      // tail (backend's dedup is per-kind, not per-batch).
      const existingIds = new Set(state.map((s) => s.id));
      const fresh = action.items.filter((it) => !existingIds.has(it.id));
      return fresh.length > 0 ? [...fresh, ...state] : state;
    }
  }
}

/** Convert a batch of ServerMessages (a history page) into StreamItems. */
function eventsToItems(events: ServerMessage[], startOffset: number): StreamItem[] {
  const items: StreamItem[] = [];
  let idx = 0;
  for (const e of events) {
    const slot = startOffset + idx++;
    switch (e.type) {
      case "user_prompt":
        items.push({
          kind: "user",
          id: `u-${e.timestamp}-${slot}`,
          sessionId: e.sessionId,
          text: e.text,
          timestamp: e.timestamp,
        });
        break;
      case "assistant_text":
        items.push({
          kind: "assistant",
          id: `a-${e.turnId}-${slot}`,
          sessionId: e.sessionId,
          text: e.text,
          timestamp: e.timestamp,
        });
        break;
      case "tool_call":
        items.push({
          kind: "tool",
          id: e.toolUseId,
          sessionId: e.sessionId,
          toolName: e.name,
          input: e.input,
          result: null,
        });
        break;
      case "tool_result": {
        // Fuse into the matching tool_call if it's in the same batch.
        const match = items.find((it) => it.kind === "tool" && it.id === e.toolUseId);
        if (match && match.kind === "tool") {
          match.result = { value: e.result, isError: e.isError };
        }
        break;
      }
      case "approval_request":
        items.push({
          kind: "approval",
          id: e.toolUseId,
          sessionId: e.sessionId,
          toolName: e.toolName,
          toolInput: e.toolInput,
        });
        break;
      case "compact_summary":
        items.push({
          kind: "compact_summary",
          id: `c-${e.timestamp}-${slot}`,
          sessionId: e.sessionId,
          text: e.text,
          timestamp: e.timestamp,
        });
        break;
      default:
        break;
    }
  }
  return items;
}

interface MessageStreamProps {
  sessionId: string;
}

export function MessageStream({ sessionId }: MessageStreamProps) {
  const [items, dispatch] = useReducer(reducer, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

  const [earliestIndex, setEarliestIndex] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [compacting, setCompacting] = useState(false);

  // Anchor tracking for scroll preservation on prepend.
  const prevScrollHeightRef = useRef(0);
  const prevFirstIdRef = useRef<string | undefined>(undefined);
  const pendingAnchorRef = useRef<{ height: number; top: number } | null>(null);

  // Reset when switching sessions
  useEffect(() => {
    dispatch({ type: "clear" });
    setEarliestIndex(null);
    setHasMore(false);
    setLoadingHistory(false);
    setCompacting(false);
    prevFirstIdRef.current = undefined;
    prevScrollHeightRef.current = 0;
    pendingAnchorRef.current = null;
  }, []);

  useWsMessage("user_prompt", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "user_prompt",
      sessionId: msg.sessionId,
      text: msg.text,
      timestamp: msg.timestamp,
    });
  });

  useWsMessage("assistant_text", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "assistant_text",
      sessionId: msg.sessionId,
      turnId: msg.turnId,
      text: msg.text,
      timestamp: msg.timestamp,
    });
  });

  useWsMessage("tool_call", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "tool_call",
      sessionId: msg.sessionId,
      toolUseId: msg.toolUseId,
      toolName: msg.name,
      input: msg.input,
    });
  });

  useWsMessage("tool_result", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "tool_result",
      sessionId: msg.sessionId,
      toolUseId: msg.toolUseId,
      result: msg.result,
      isError: msg.isError,
    });
  });

  useWsMessage("compact_start", (msg) => {
    if (msg.sessionId !== sessionId) return;
    setCompacting(true);
  });

  useWsMessage("compact_end", (msg) => {
    if (msg.sessionId !== sessionId) return;
    setCompacting(false);
  });

  useWsMessage("compact_summary", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "compact_summary",
      sessionId: msg.sessionId,
      text: msg.text,
      timestamp: msg.timestamp,
    });
  });

  useWsMessage("approval_request", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "approval_request",
      sessionId: msg.sessionId,
      toolUseId: msg.toolUseId,
      toolName: msg.toolName,
      toolInput: msg.toolInput,
    });
  });

  useWsMessage("history_available", (msg) => {
    if (msg.sessionId !== sessionId) return;
    setEarliestIndex(msg.earliestIndex);
    setHasMore(msg.hasMore);
  });

  useWsMessage("history_page", (msg) => {
    if (msg.sessionId !== sessionId) return;
    // Record the current scroll position so we can preserve visible content.
    const el = scrollRef.current;
    if (el) {
      pendingAnchorRef.current = {
        height: el.scrollHeight,
        top: el.scrollTop,
      };
    }
    const newItems = eventsToItems(msg.events, msg.fromIndex);
    dispatch({ type: "prepend", items: newItems });
    setEarliestIndex(msg.fromIndex);
    setHasMore(msg.hasMore);
    setLoadingHistory(false);
  });

  const loadMoreHistory = useCallback(() => {
    if (loadingHistory || !hasMore || earliestIndex === null || earliestIndex <= 0) return;
    setLoadingHistory(true);
    wsService.send({
      type: "fetch_history",
      sessionId,
      beforeIndex: earliestIndex,
      limit: HISTORY_PAGE_SIZE,
    });
  }, [sessionId, earliestIndex, hasMore, loadingHistory]);

  // Top-sentinel observer for upward scroll.
  useEffect(() => {
    const el = topSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreHistory();
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMoreHistory]);

  // Chat-style scroll logic: jump to bottom on initial/append, preserve
  // visible content position on prepend. Runs before paint so there's no
  // flash of wrong-scroll content.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const anchor = pendingAnchorRef.current;
    if (anchor) {
      // Prepend: keep the user looking at the same content as before.
      const delta = el.scrollHeight - anchor.height;
      el.scrollTop = anchor.top + delta;
      pendingAnchorRef.current = null;
    } else {
      // Initial load or append: jump to bottom (no smooth animation).
      el.scrollTop = el.scrollHeight;
    }

    prevScrollHeightRef.current = el.scrollHeight;
    prevFirstIdRef.current = items[0]?.id;
  }, [items]);

  const lastItem = items[items.length - 1];
  // Keep the spinner visible while tools are running / approvals are pending —
  // only a final assistant message (or no activity at all) means "idle".
  const waitingForReply =
    !!lastItem && lastItem.kind !== "assistant" && lastItem.kind !== "compact_summary";

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-2 pb-6 pt-4">
        {hasMore && <div ref={topSentinelRef} className="h-1" />}
        {loadingHistory && (
          <div className="px-4 py-2 text-center text-sm text-muted-foreground/60">
            Loading earlier messages…
          </div>
        )}
        {items.length === 0 && !loadingHistory ? (
          <div className="flex h-full min-h-[60vh] items-center justify-center font-serif text-base italic text-muted-foreground/60">
            Waiting for session to start…
          </div>
        ) : (
          items.map((item) => {
            switch (item.kind) {
              case "user":
                return <UserMessage key={item.id} text={item.text} timestamp={item.timestamp} />;
              case "assistant":
                return (
                  <AssistantMessage key={item.id} text={item.text} timestamp={item.timestamp} />
                );
              case "tool":
                if (item.toolName === "AskUserQuestion") {
                  return (
                    <QuestionCard
                      key={item.id}
                      toolUseId={item.id}
                      input={item.input}
                      result={item.result}
                    />
                  );
                }
                return (
                  <ToolCallCard
                    key={item.id}
                    toolName={item.toolName}
                    input={item.input}
                    result={item.result}
                  />
                );
              case "approval":
                return (
                  <ApprovalCard
                    key={item.id}
                    sessionId={item.sessionId}
                    toolUseId={item.id}
                    toolName={item.toolName}
                    toolInput={item.toolInput}
                    resolved={item.resolved}
                  />
                );
              case "compact_summary":
                return (
                  <div
                    key={item.id}
                    className="mx-4 my-4 rounded-xl border border-border/60 bg-card/60 px-4 py-3"
                  >
                    <div className="mb-2 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                      Conversation compacted
                    </div>
                    <Markdown text={item.text} />
                  </div>
                );
              default:
                return null;
            }
          })
        )}
        {compacting && (
          <div className="mx-4 my-2 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/[0.06] px-3 py-2 text-sm text-warning">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
            Compacting conversation… Claude will be unresponsive until this finishes.
          </div>
        )}
        {waitingForReply && !compacting && <ThinkingIndicator />}
      </div>
    </div>
  );
}
