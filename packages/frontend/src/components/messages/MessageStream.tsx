import type { ClaudeModel, ServerMessage, ToolResult } from "common/types";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ApprovalCard } from "@/components/messages/ApprovalCard";
import { AssistantMessage } from "@/components/messages/AssistantMessage";
import { Markdown } from "@/components/messages/Markdown";
import { PlanCard } from "@/components/messages/PlanCard";
import { QuestionCard } from "@/components/messages/QuestionCard";
import { ThinkingIndicator } from "@/components/messages/ThinkingIndicator";
import { ToolCallCard } from "@/components/messages/ToolCallCard";
import { UserMessage } from "@/components/messages/UserMessage";
import { useWsMessage } from "@/hooks/use-ws";
import { wsService } from "@/services/ws.service";

/** Min consecutive tool cards before we collapse them into a single pill. */
const TOOL_GROUP_COLLAPSE_THRESHOLD = 3;

const HISTORY_PAGE_SIZE = 20;

export type StreamItem =
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
      /**
       * Stable identity for React keys. `id` gets promoted from a
       * content-hashed `pr:` placeholder to the real `toolu_` id once the JSONL
       * flushes, and two AskUserQuestion calls with identical question/options
       * share a content-hashed id — so keying on `id`/content collides. `uid`
       * is assigned once at creation and never changes, keeping same-text
       * questions distinct and surviving id promotion without remounting.
       */
      uid: string;
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

export type Action =
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
  | { type: "prepend"; items: StreamItem[]; results?: Record<string, ToolResult> };

export interface State {
  items: StreamItem[];
  /** Monotonic counter for minting stable tool `uid`s (see StreamItem.tool). */
  seq: number;
  /**
   * tool_use_id → result, kept independently of `items` so a tool_result can
   * land on its tool card regardless of arrival order. The live `tool_result`
   * path and the history-pagination path deliver call and result in separate
   * batches; without this map, a result whose tool_call isn't yet present (or
   * is in a different page) would attach to nothing and the card would render
   * as unanswered. `fuseResults` reconciles the map onto items on every change.
   */
  results: Record<string, ToolResult>;
}

export const INITIAL_STATE: State = { items: [], seq: 0, results: {} };

/** Attach known results to any tool item still missing one. Returns the same
 *  array reference when nothing changed so React bail-outs still work. */
function fuseResults(items: StreamItem[], results: Record<string, ToolResult>): StreamItem[] {
  let changed = false;
  const next = items.map((it) => {
    if (it.kind === "tool" && !it.result && results[it.id]) {
      changed = true;
      return { ...it, result: results[it.id] };
    }
    return it;
  });
  return changed ? next : items;
}

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

export function reducer(state: State, action: Action): State {
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
    case "tool_call": {
      if (state.items.some((it) => it.kind === "tool" && it.id === action.toolUseId)) {
        return state;
      }
      // AskUserQuestion is pre-populated from the approval_request (which fires
      // before the JSONL flushes tool_call) under a synthesized id of the form
      // `pr:<tool>:<hash>`, because the PermissionRequest hook payload doesn't
      // include the real tool_use_id. When the real tool_call finally arrives,
      // promote the existing item's id to the real one so the eventual
      // tool_result (keyed by real id) lands on the right item.
      //
      // We match by id prefix rather than by serialized input — the controller
      // only ever has one pending AskUserQuestion at a time, and JSON.stringify
      // equality is fragile (object key order can differ between the hook's
      // parsed input and the JSONL's parsed input).
      if (action.toolName === "AskUserQuestion") {
        // Promote the OLDEST un-resolved placeholder (FIFO) — only one
        // AskUserQuestion is pending at a time, so the oldest still-pending
        // `pr:` placeholder is the one this real tool_call corresponds to.
        // Preserve its `uid` so the card doesn't remount (keeping in-progress
        // input) and so two same-text questions stay distinct.
        const existingIdx = state.items.findIndex(
          (it) =>
            it.kind === "tool" &&
            it.toolName === "AskUserQuestion" &&
            it.id.startsWith("pr:") &&
            !it.result,
        );
        if (existingIdx >= 0) {
          // Relocate the placeholder to the tail rather than promoting in
          // place. The approval_request hook fires (and creates the card)
          // before the transcript watcher tails the assistant_text that
          // precedes this tool call in the JSONL — so the card was inserted
          // one slot too early, above its own "Round N" announcement. By the
          // time this real tool_call arrives, that assistant_text has already
          // been pushed (the drain parses text before tool_use, in file
          // order), so re-appending the card here lands it after its
          // announcement. Preserve `uid` so the card doesn't remount.
          const existing = state.items[existingIdx] as Extract<StreamItem, { kind: "tool" }>;
          const rest = state.items.filter((_it, i) => i !== existingIdx);
          const promoted = [...rest, { ...existing, id: action.toolUseId }];
          return { ...state, items: fuseResults(promoted, state.results) };
        }
      }
      return {
        ...state,
        seq: state.seq + 1,
        items: fuseResults(
          [
            ...state.items,
            {
              kind: "tool",
              id: action.toolUseId,
              uid: `t${state.seq}`,
              sessionId: action.sessionId,
              toolName: action.toolName,
              input: action.input,
              result: null,
            },
          ],
          state.results,
        ),
      };
    }
    case "tool_result": {
      // Record in the map first so the result survives even if its tool_call
      // hasn't arrived (or is in a not-yet-loaded history page), then fuse.
      const results = {
        ...state.results,
        [action.toolUseId]: { value: action.result, isError: action.isError },
      };
      return { ...state, results, items: fuseResults(state.items, results) };
    }
    case "approval_request": {
      const added: StreamItem[] = [];
      if (!state.items.some((it) => it.kind === "approval" && it.id === action.toolUseId)) {
        added.push({
          kind: "approval",
          id: action.toolUseId,
          sessionId: action.sessionId,
          toolName: action.toolName,
          toolInput: action.toolInput,
        });
      }
      // AskUserQuestion: the PermissionRequest hook normally fires before the
      // transcript JSONL records the tool_call, so without this the UI sits
      // blank between "user prompt sent" and "tool_call arrives". Pre-populate
      // the tool item from the approval payload.
      //
      // Dedupe against ANY pending (un-resulted) AskUserQuestion card, not just
      // one sharing this approval's synthesized `pr:` id. Only one
      // AskUserQuestion is pending at a time, so a pending card already
      // represents this question — whether it was created by an earlier
      // approval_request (`pr:` id) or by the real tool_call (`toolu_` id),
      // whichever the bus delivered first. Matching on the `pr:` id alone misses
      // the tool_call-first ordering (fs.watch can beat the hook), which spawned
      // an orphan duplicate card that never resolved — visible as editable
      // "already answered" questions after a mid-interview reload.
      let seq = state.seq;
      const pendingQuestionExists = state.items.some(
        (it) => it.kind === "tool" && it.toolName === "AskUserQuestion" && !it.result,
      );
      if (action.toolName === "AskUserQuestion" && !pendingQuestionExists) {
        added.push({
          kind: "tool",
          id: action.toolUseId,
          uid: `t${seq}`,
          sessionId: action.sessionId,
          toolName: action.toolName,
          input: action.toolInput,
          result: null,
        });
        seq += 1;
      }
      if (added.length === 0) return state;
      return { ...state, seq, items: fuseResults([...state.items, ...added], state.results) };
    }
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
      // Merge any results carried by this history page into the map, then fuse
      // across the whole list: a prepended tool_call may have its result in an
      // already-loaded page (now in the map), and a prepended result may belong
      // to a tool_call already in the stream.
      const results = action.results ? { ...state.results, ...action.results } : state.results;
      if (fresh.length === 0 && results === state.results) return state;
      return { ...state, results, items: fuseResults([...fresh, ...state.items], results) };
    }
  }
}

/** Convert a batch of ServerMessages (a history page) into StreamItems plus a
 *  map of every tool_result seen — including ones whose tool_call lives in a
 *  different page, which the reducer fuses globally once that call loads. */
export function eventsToItems(
  events: ServerMessage[],
  startOffset: number,
): { items: StreamItem[]; results: Record<string, ToolResult> } {
  const items: StreamItem[] = [];
  const results: Record<string, ToolResult> = {};
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
          uid: `h-${e.toolUseId}`,
          sessionId: e.sessionId,
          toolName: e.name,
          input: e.input,
          result: null,
        });
        break;
      case "tool_result": {
        // Record every result; the reducer fuses it onto the tool card whether
        // or not the matching tool_call is in this same page.
        results[e.toolUseId] = { value: e.result, isError: e.isError };
        const match = items.find((it) => it.kind === "tool" && it.id === e.toolUseId);
        if (match && match.kind === "tool") {
          match.result = results[e.toolUseId];
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
  return { items, results };
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
  /**
   * Reports whether any AskUserQuestion is still awaiting an answer. Computed
   * here (not in SessionView) because the reducer is the single source of truth
   * that reconciles the synthesized `pr:` approval id with the real
   * tool_use_id — the raw WS events alone can't be matched reliably.
   */
  onPendingQuestionChange?: (pending: boolean) => void;
  /** The session's running model — passed to PlanCard to label the approve
   *  buttons (auto mode vs auto-accept edits). Optional: the stream stays
   *  mounted while `session` is still resolving, and the label is cosmetic (the
   *  backend computes the actual resulting mode from the running model). */
  model?: ClaudeModel;
}

export function MessageStream({
  sessionId,
  inFlightPreview,
  isProcessing,
  onPendingQuestionChange,
  model,
}: MessageStreamProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const items = state.items;

  // An AskUserQuestion is pending while its tool item has no result yet.
  const hasPendingQuestion = items.some(
    (it) => it.kind === "tool" && it.toolName === "AskUserQuestion" && !it.result,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire only when the flag flips
  useEffect(() => {
    onPendingQuestionChange?.(hasPendingQuestion);
  }, [hasPendingQuestion]);
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
    const { items: newItems, results } = eventsToItems(msg.events, msg.fromIndex);
    dispatch({ type: "prepend", items: newItems, results });
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

  // Walk past AskUserQuestion approval items — they're suppressed in render
  // (the QuestionCard owns the UI), and they never resolve, so they'd
  // otherwise pin "last item" to a pseudo-pending state forever.
  let effectiveLastItem: StreamItem | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "approval" && it.toolName === "AskUserQuestion") continue;
    effectiveLastItem = it;
    break;
  }
  // Keep the spinner visible while tools are running / approvals are pending —
  // assistant text, compact summary, local slash commands, and interrupts are
  // terminal. `isProcessing` from SessionView covers the gap between submit
  // and the bus echo arriving (no items yet but a turn is in flight).
  // AskUserQuestion and ExitPlanMode are special: while waiting on the user (no
  // result yet) or after a cancel/error (result.isError), the CLI's turn is not
  // in flight — the card is waiting for a tap, so the spinner would mislead. A
  // resolved success (result.isError === false) still falls through to the
  // regular "tool returned, Claude is thinking" path.
  const relayToolUnresolved =
    effectiveLastItem?.kind === "tool" &&
    (effectiveLastItem.toolName === "AskUserQuestion" ||
      effectiveLastItem.toolName === "ExitPlanMode") &&
    (!effectiveLastItem.result || effectiveLastItem.result.isError);
  const waitingForReply =
    !relayToolUnresolved &&
    (isProcessing ||
      (!!effectiveLastItem &&
        effectiveLastItem.kind !== "assistant" &&
        effectiveLastItem.kind !== "compact_summary" &&
        effectiveLastItem.kind !== "slash_command" &&
        effectiveLastItem.kind !== "interrupt"));

  // Loader elapsed-time anchor: the user's message time, so the timer reflects
  // real wait and survives a refresh (the last user_prompt reloads from history
  // with its original timestamp). Prefer the still-in-flight preview when present.
  let turnStartedAtIso = inFlightPreview?.timestamp;
  if (!turnStartedAtIso) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "user") {
        turnStartedAtIso = it.timestamp;
        break;
      }
    }
  }
  const turnStartedAt = turnStartedAtIso ? Date.parse(turnStartedAtIso) : undefined;

  // The item-list effect above only fires on `items` changes, so the loader and
  // the optimistic preview (driven by props, rendered outside the list) wouldn't
  // scroll into view when they appear. Snap to bottom when the loader shows or a
  // new message is sent — unless the user has scrolled up more than half a
  // viewport to read, in which case leave them be. Keyed on the in-flight
  // timestamp (stable per message) rather than the freshly-built preview object,
  // so consecutive sends each trigger a scroll without firing every re-render.
  const inFlightTimestamp = inFlightPreview?.timestamp;
  useLayoutEffect(() => {
    if (!waitingForReply && !inFlightTimestamp) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > el.clientHeight * 0.5) return;
    el.scrollTop = el.scrollHeight;
  }, [waitingForReply, inFlightTimestamp]);

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
  // AskUserQuestion cards are interactive and must never be collapsed into the
  // tool-group toggle — a pending question hidden behind "Show N tool calls" is
  // unanswerable. They break a tool run and always render standalone.
  const isGroupable = (it: StreamItem): boolean =>
    it.kind === "tool" && it.toolName !== "AskUserQuestion" && it.toolName !== "ExitPlanMode";
  const renderEntries: RenderEntry[] = [];
  let cursor = 0;
  while (cursor < items.length) {
    const item = items[cursor];
    if (isGroupable(item)) {
      const start = cursor;
      while (cursor < items.length && isGroupable(items[cursor])) cursor++;
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
                            key={questionCardKey(it)}
                            sessionId={it.sessionId}
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
                      key={questionCardKey(item)}
                      sessionId={item.sessionId}
                      toolUseId={item.id}
                      input={item.input}
                      result={item.result}
                    />
                  );
                }
                if (item.toolName === "ExitPlanMode") {
                  return (
                    <PlanCard
                      key={item.id}
                      sessionId={item.sessionId}
                      toolUseId={item.id}
                      input={item.input}
                      result={item.result}
                      model={model}
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
                // AskUserQuestion fires its own interactive UI via QuestionCard
                // — the parallel approval card would just be a redundant prompt.
                if (item.toolName === "AskUserQuestion") return null;
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
        {waitingForReply && !compacting && <ThinkingIndicator startedAt={turnStartedAt} />}
      </div>
    </div>
  );
}

// Stable React key for AskUserQuestion cards. Keying on `uid` (assigned once,
// never mutated) rather than `id` (which flips from the `pr:` placeholder to
// the real tool_use_id) or content (which collides when the model asks the
// same question twice) keeps the component mounted across id promotion AND
// keeps two same-text questions rendered as distinct cards.
function questionCardKey(it: Extract<StreamItem, { kind: "tool" }>): string {
  return `q-${it.uid}`;
}
