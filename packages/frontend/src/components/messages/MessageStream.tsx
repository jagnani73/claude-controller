import type { ServerMessage } from "common/types";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
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

/** Min consecutive tool cards before we collapse them into a single pill. */
const TOOL_GROUP_COLLAPSE_THRESHOLD = 3;

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
    }
  | {
      kind: "slash_command";
      id: string;
      sessionId: string;
      name: string;
      args?: string;
      output?: string;
      timestamp: string;
    }
  | {
      kind: "interrupt";
      id: string;
      sessionId: string;
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
  | {
      type: "slash_command";
      sessionId: string;
      name: string;
      args?: string;
      output?: string;
      timestamp: string;
    }
  | {
      type: "interrupt";
      sessionId: string;
      timestamp: string;
    }
  | { type: "prepend"; items: StreamItem[] };

interface State {
  items: StreamItem[];
}

const INITIAL_STATE: State = { items: [] };

function makeUserItem(
  args: { text: string; timestamp: string; sessionId: string },
  slot: number,
): Extract<StreamItem, { kind: "user" }> {
  return {
    kind: "user",
    id: `u-${args.timestamp}-${slot}`,
    sessionId: args.sessionId,
    text: args.text,
    timestamp: args.timestamp,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "clear":
      return INITIAL_STATE;
    case "user_prompt": {
      // Identity dedup defends against the bus replaying the same event
      // (reconnect / re-subscribe); two intentional same-text sends have
      // distinct backend timestamps so both pass through.
      const dup = state.items.some(
        (it) =>
          it.kind === "user" &&
          it.text === action.text &&
          it.timestamp === action.timestamp &&
          it.sessionId === action.sessionId,
      );
      if (dup) return state;
      return {
        ...state,
        items: [...state.items, makeUserItem(action, state.items.length)],
      };
    }
    case "assistant_text": {
      if (
        state.items.some(
          (it) =>
            it.kind === "assistant" && it.text === action.text && it.sessionId === action.sessionId,
        )
      ) {
        return state;
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "assistant",
            id: `a-${action.turnId}-${state.items.length}`,
            sessionId: action.sessionId,
            text: action.text,
            timestamp: action.timestamp,
          },
        ],
      };
    }
    case "tool_call":
      if (state.items.some((it) => it.kind === "tool" && it.id === action.toolUseId)) {
        return state;
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool",
            id: action.toolUseId,
            sessionId: action.sessionId,
            toolName: action.toolName,
            input: action.input,
            result: null,
          },
        ],
      };
    case "tool_result":
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "tool" && it.id === action.toolUseId
            ? { ...it, result: { value: action.result, isError: action.isError } }
            : it,
        ),
      };
    case "approval_request":
      if (state.items.some((it) => it.kind === "approval" && it.id === action.toolUseId)) {
        return state;
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "approval",
            id: action.toolUseId,
            sessionId: action.sessionId,
            toolName: action.toolName,
            toolInput: action.toolInput,
          },
        ],
      };
    case "approval_resolved":
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "approval" && it.id === action.toolUseId
            ? { ...it, resolved: action.decision }
            : it,
        ),
      };
    case "compact_summary": {
      const id = `c-${action.timestamp}-${state.items.length}`;
      if (state.items.some((it) => it.kind === "compact_summary" && it.id === id)) return state;
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "compact_summary",
            id,
            sessionId: action.sessionId,
            text: action.text,
            timestamp: action.timestamp,
          },
        ],
      };
    }
    case "slash_command":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "slash_command",
            id: `s-${action.timestamp}-${action.name}-${state.items.length}`,
            sessionId: action.sessionId,
            name: action.name,
            args: action.args,
            output: action.output,
            timestamp: action.timestamp,
          },
        ],
      };
    case "interrupt": {
      // Defensive de-dup against back-to-back interrupt events.
      const last = state.items[state.items.length - 1];
      if (last && last.kind === "interrupt") return state;
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "interrupt",
            id: `int-${action.timestamp}-${state.items.length}`,
            sessionId: action.sessionId,
            timestamp: action.timestamp,
          },
        ],
      };
    }
    case "prepend": {
      const existingIds = new Set(state.items.map((s) => s.id));
      const fresh = action.items.filter((it) => !existingIds.has(it.id));
      return fresh.length > 0 ? { ...state, items: [...fresh, ...state.items] } : state;
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
      case "slash_command":
        items.push({
          kind: "slash_command",
          id: `s-${e.timestamp}-${e.name}-${slot}`,
          sessionId: e.sessionId,
          name: e.name,
          args: e.args,
          output: e.output,
          timestamp: e.timestamp,
        });
        break;
      case "interrupt":
        items.push({
          kind: "interrupt",
          id: `int-${e.timestamp}-${slot}`,
          sessionId: e.sessionId,
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
  /**
   * If non-null, the in-flight queue item drawn as a preview bubble at the
   * end of the stream. This is the optimistic rendering — the user sees
   * their message instantly even before the bus echo arrives. Once the bus
   * echoes the prompt (and the canonical bubble lands in `items`),
   * SessionView clears this prop so the preview goes away without leaving
   * a duplicate.
   */
  inFlightPreview?: { text: string; timestamp: string } | null;
  /**
   * True whenever the frontend queue has work in-flight (sent or bus-acked,
   * waiting for assistant_text). Drives the thinking indicator independently
   * of whether the bus has echoed the user_prompt yet — without it the
   * loader would flicker off during the ~100ms gap before the echo lands.
   */
  isProcessing?: boolean;
}

export function MessageStream({ sessionId, inFlightPreview, isProcessing }: MessageStreamProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const items = state.items;
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

  // Reset when switching sessions. The component instance is reused across
  // /session/$id route changes, so without `sessionId` in the dep list the
  // previous session's stream items leak into the new one.
  useEffect(() => {
    dispatch({ type: "clear" });
    setEarliestIndex(null);
    setHasMore(false);
    setLoadingHistory(false);
    setCompacting(false);
    prevFirstIdRef.current = undefined;
    prevScrollHeightRef.current = 0;
    pendingAnchorRef.current = null;
  }, [sessionId]);

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

  useWsMessage("slash_command", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "slash_command",
      sessionId: msg.sessionId,
      name: msg.name,
      args: msg.args,
      output: msg.output,
      timestamp: msg.timestamp,
    });
  });

  useWsMessage("interrupt", (msg) => {
    if (msg.sessionId !== sessionId) return;
    dispatch({
      type: "interrupt",
      sessionId: msg.sessionId,
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
  // assistant text, compact summary, local slash commands, and interrupts are
  // terminal. `isProcessing` from SessionView covers the gap between submit
  // and the bus echo arriving (no items yet but a turn is in flight).
  const waitingForReply =
    isProcessing ||
    (!!lastItem &&
      lastItem.kind !== "assistant" &&
      lastItem.kind !== "compact_summary" &&
      lastItem.kind !== "slash_command" &&
      lastItem.kind !== "interrupt");

  const [toolGroupOverride, setToolGroupOverride] = useState<Record<string, "open" | "closed">>({});
  const toggleToolGroup = useCallback((groupId: string, openByDefault: boolean) => {
    setToolGroupOverride((prev) => {
      const current = prev[groupId] ?? (openByDefault ? "open" : "closed");
      return { ...prev, [groupId]: current === "open" ? "closed" : "open" };
    });
  }, []);

  type RenderEntry =
    | { kind: "single"; item: StreamItem }
    | { kind: "tool-group"; groupId: string; items: Extract<StreamItem, { kind: "tool" }>[] };
  const renderEntries: RenderEntry[] = [];
  let cursor = 0;
  while (cursor < items.length) {
    const item = items[cursor];
    if (item.kind === "tool") {
      const start = cursor;
      while (cursor < items.length && items[cursor].kind === "tool") cursor++;
      const run = items.slice(start, cursor) as Extract<StreamItem, { kind: "tool" }>[];
      if (run.length >= TOOL_GROUP_COLLAPSE_THRESHOLD) {
        renderEntries.push({ kind: "tool-group", groupId: run[0].id, items: run });
      } else {
        for (const r of run) renderEntries.push({ kind: "single", item: r });
      }
    } else {
      renderEntries.push({ kind: "single", item });
      cursor++;
    }
  }

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
          renderEntries.map((entry) => {
            if (entry.kind === "tool-group") {
              const isOpen = toolGroupOverride[entry.groupId] === "open";
              const uniqueTools = Array.from(new Set(entry.items.map((it) => it.toolName)));
              const preview = uniqueTools.slice(0, 3).join(" · ");
              const more = uniqueTools.length > 3 ? ` · +${uniqueTools.length - 3} more` : "";
              return (
                <div key={`group-${entry.groupId}`} className="px-4">
                  <button
                    type="button"
                    onClick={() => toggleToolGroup(entry.groupId, false)}
                    className="group/group flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 bg-card/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 ease-out hover:border-accent/40 hover:bg-card/60 hover:text-foreground"
                  >
                    {isOpen ? (
                      <ChevronsDownUp className="size-3.5 text-accent" strokeWidth={2} />
                    ) : (
                      <ChevronsUpDown className="size-3.5 text-accent" strokeWidth={2} />
                    )}
                    <span className="font-medium">
                      {isOpen ? "Hide" : "Show"} {entry.items.length} tool calls
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground/60">
                      {preview}
                      {more}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-1">
                      {entry.items.map((it) =>
                        it.toolName === "AskUserQuestion" ? (
                          <QuestionCard
                            key={it.id}
                            toolUseId={it.id}
                            input={it.input}
                            result={it.result}
                          />
                        ) : (
                          <ToolCallCard
                            key={it.id}
                            toolName={it.toolName}
                            input={it.input}
                            result={it.result}
                          />
                        ),
                      )}
                    </div>
                  )}
                </div>
              );
            }
            const item = entry.item;
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
              case "slash_command":
                return (
                  <div
                    key={item.id}
                    className="mx-auto my-3 flex w-full max-w-md flex-col items-center gap-0.5 px-4 text-center font-mono text-[11px]"
                  >
                    <span className="text-accent">
                      <span className="font-semibold">{item.name}</span>
                      {item.args && <span className="text-accent/80"> {item.args}</span>}
                    </span>
                    {item.output && (
                      <span className="whitespace-pre-wrap text-muted-foreground/80">
                        {item.output}
                      </span>
                    )}
                  </div>
                );
              case "interrupt":
                return (
                  <div
                    key={item.id}
                    className="mx-auto my-3 flex w-full max-w-md items-center justify-center px-4 text-center font-mono text-[11px] text-warning/80"
                  >
                    <span>⎿ Interrupted · What should Claude do instead?</span>
                  </div>
                );
              default:
                return null;
            }
          })
        )}
        {inFlightPreview && (
          <UserMessage text={inFlightPreview.text} timestamp={inFlightPreview.timestamp} />
        )}
        {compacting && (
          <div className="mx-4 my-2 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/6 px-3 py-2 text-sm text-warning">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
            Compacting conversation… Claude will be unresponsive until this finishes.
          </div>
        )}
        {waitingForReply && !compacting && <ThinkingIndicator />}
      </div>
    </div>
  );
}
