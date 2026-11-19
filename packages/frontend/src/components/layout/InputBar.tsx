import { BUILTIN_COMMANDS, type CommandEntry, commandDecision } from "common/commands";
import { ArrowUp, Slash as SlashIcon, Square, Terminal as TerminalIcon } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { useWsMessage } from "@/hooks/use-ws";
import { wsService } from "@/services/ws.service";
import { inputPrefixHint, inputPrefixMode } from "./input-prefix";

export interface InputBarHandle {
  /** Replace the textarea contents and focus it. Used by QueuePanel "edit" taps. */
  loadDraft: (text: string) => void;
}

interface InputBarProps {
  sessionId: string;
  onSubmit: (text: string) => void;
  /** Optional element rendered to the left of the textarea (e.g. settings popover trigger). */
  settingsSlot?: ReactNode;
  /**
   * Most recent non-slash user message — populated into the input on Up
   * arrow when the field is empty. Single-shot recall: pressing Up again
   * does nothing because the field is no longer empty.
   */
  recallText?: string | null;
  /**
   * If non-null, Esc pops the queue tail back into the input bar instead of
   * sending an interrupt. The parent (SessionView) owns the queue and
   * provides the tail text; calling `onPopQueueTail` removes it from the
   * queue. Interrupt only fires when the queue is empty.
   */
  queueTail?: string | null;
  onPopQueueTail?: () => void;
  /** Esc keystroke when the queue is empty — interrupts Claude's current turn. */
  onInterrupt?: () => void;
  /**
   * Ctrl/Cmd+Enter — "send now": interrupt the running turn and send this
   * text next, ahead of anything queued. With an empty box it is called with
   * `null` and sends the oldest queued item now. The counterpart of Esc: Esc
   * pulls the newest queued item back, Ctrl+Enter pushes the oldest forward.
   */
  onSubmitNow?: (text: string | null) => void;
  /**
   * Whether a send is in-flight. When true and the input is empty, the send
   * button morphs into a Stop button that calls `onInterrupt` — the on-screen
   * equivalent of Esc-to-interrupt (so phones, which have no Esc key, can stop
   * a running turn). Typing flips it back to Send, since text takes priority
   * (the message queues without interrupting).
   */
  isProcessing?: boolean;
}

/**
 * Same-text submissions within this window are suppressed. Sized to swallow
 * physical-event artifacts (touch+click pair, held Enter autorepeat, React
 * batching letting two synthetic events see the same uncleared `text`
 * state) while still allowing a user to deliberately re-send identical
 * text after a beat. Logs that motivated this guard showed duplicates 1–18
 * ms apart; a real user can't manually re-type and re-submit faster than
 * ~150 ms, so 500 ms is comfortable in both directions.
 */
const SAME_TEXT_DEDUP_MS = 500;

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar(
  {
    onSubmit,
    sessionId,
    settingsSlot,
    recallText,
    queueTail,
    onPopQueueTail,
    onInterrupt,
    onSubmitNow,
    isProcessing,
  },
  ref,
) {
  const [text, setText] = useState("");
  const [catalog, setCatalog] = useState<{
    sessionId: string;
    entries: CommandEntry[];
    status: string;
  }>({
    sessionId,
    entries: BUILTIN_COMMANDS,
    status: "",
  });
  const [notice, setNotice] = useState<{ sessionId: string; text: string }>({
    sessionId,
    text: "",
  });
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const requestRef = useRef<{
    sessionId: string;
    id: string;
    generation: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const pickerRef = useRef<HTMLDivElement>(null);
  const rejections = useSyncExternalStore(
    (handler) => wsService.onRejectedCommands(handler),
    () => wsService.getRejectedCommands(sessionId),
  );
  const cancelRequest = useCallback(() => {
    if (requestRef.current) clearTimeout(requestRef.current.timer);
    requestRef.current = null;
  }, []);
  const requestCatalog = () => {
    if (requestRef.current?.sessionId === sessionId) return;
    cancelRequest();
    const id = crypto.randomUUID();
    if (!wsService.sendImmediate({ type: "command_catalog_request", sessionId, requestId: id })) {
      setCatalog({
        sessionId,
        entries: BUILTIN_COMMANDS,
        status: "Catalog unavailable offline. Retry after reconnecting.",
      });
      return;
    }
    const generation = wsService.socketGeneration;
    const timer = setTimeout(() => {
      if (requestRef.current?.id !== id) return;
      requestRef.current = null;
      setCatalog({
        sessionId,
        entries: BUILTIN_COMMANDS,
        status: "Catalog request timed out. Retry.",
      });
    }, 8000);
    requestRef.current = { sessionId, id, generation, timer };
    setCatalog({ sessionId, entries: BUILTIN_COMMANDS, status: "Loading commands…" });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on session change
  useEffect(() => {
    cancelRequest();
    setDismissed(false);
    setSelected(0);
    return cancelRequest;
  }, [sessionId, cancelRequest]);
  useEffect(
    () =>
      wsService.onStateChange((state) => {
        if (state === "connected") return;
        cancelRequest();
        setCatalog({
          sessionId: sessionRef.current,
          entries: BUILTIN_COMMANDS,
          status: "Catalog unavailable offline. Retry after reconnecting.",
        });
      }),
    [cancelRequest],
  );
  useWsMessage("history_available", (msg) => {
    if (msg.sessionId === sessionId && text.trimStart().startsWith("/")) requestCatalog();
  });
  useWsMessage("command_catalog", (msg) => {
    const request = requestRef.current;
    if (
      !request ||
      msg.sessionId !== sessionId ||
      msg.sessionId !== request.sessionId ||
      msg.requestId !== request.id ||
      request.generation !== wsService.socketGeneration
    )
      return;
    cancelRequest();
    setCatalog({
      sessionId,
      entries: msg.entries.length ? msg.entries : BUILTIN_COMMANDS,
      status:
        msg.error ?? [...msg.warnings, ...(msg.truncated ? ["Catalog truncated."] : [])].join(" "),
    });
  });
  const entries = catalog.sessionId === sessionId ? catalog.entries : BUILTIN_COMMANDS;
  const catalogStatus = catalog.sessionId === sessionId ? catalog.status : "";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  useImperativeHandle(
    ref,
    () => ({
      loadDraft: (draft: string) => {
        setText(draft);
        const el = textareaRef.current;
        if (!el) return;
        // Defer the resize until the value commits, then focus for editing.
        requestAnimationFrame(() => {
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        });
        el.focus();
      },
    }),
    [],
  );

  /** `sendNow` (Ctrl/Cmd+Enter): interrupt and send this next instead of queueing. */
  const send = (sendNow = false) => {
    const trimmed = text.trim();
    if (!trimmed) {
      if (sendNow) onSubmitNow?.(null);
      return;
    }
    const decision = commandDecision(trimmed);
    if (decision.kind === "blocked") {
      setNotice({ sessionId, text: decision.reason ?? "Use the local CLI." });
      return;
    }
    const last = lastSentRef.current;
    const at = Date.now();
    if (last && last.text === trimmed && at - last.at < SAME_TEXT_DEDUP_MS) {
      // One physical action fired twice (touch+click on mobile, autorepeated
      // keydown, etc.). Drop the second so we don't enqueue or send a
      // duplicate the user didn't intend.
      return;
    }
    lastSentRef.current = { text: trimmed, at };
    if (sendNow && onSubmitNow) onSubmitNow(trimmed);
    else onSubmit(trimmed);
    setText("");
    // Reset the auto-grown height — the inline `style.height` set by onChange
    // persists across the value clearing, so without this the box stays tall
    // after sending a multi-line message.
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    textareaRef.current?.focus();
  };

  const hasText = text.trim().length > 0;
  // Empty box + a live turn → the button stops generation instead of sending.
  const showStop = !hasText && !!isProcessing;
  // A leading `!` or `/` changes how the CLI reads the message. The TUI says so
  // in its footer; without this the phone gave no such warning, so a message
  // meant as prose could silently run as a shell command.
  const prefixMode = inputPrefixMode(text);
  const match = /^\s*\/([^\s/]*)$/.exec(text);
  const matches = match
    ? entries
        .filter((entry) => entry.name.toLowerCase().startsWith(match[1].toLowerCase()))
        .slice(0, 30)
    : [];
  const showPicker = !!match && !dismissed && matches.length > 0;
  const choose = (entry: CommandEntry) => {
    setText(`/${entry.name} `);
    setDismissed(true);
    setNotice({ sessionId, text: entry.description });
    textareaRef.current?.focus();
  };

  return (
    <div className="mb-2 shrink-0 px-3 pb-2 pt-1">
      {rejections.length > 0 && (
        <p className="mx-auto max-w-4xl break-words px-2 text-xs text-muted-foreground">
          {wsService.getRejectedCommandsNotice()}
        </p>
      )}
      {rejections.map((item) => (
        <div key={item.id} className="mx-auto max-w-4xl break-words px-2 text-xs text-amber-500">
          {item.message} {item.truncated && "Command truncated to 32768 characters."}
          <button
            type="button"
            className="ml-2 min-h-10 underline"
            onClick={() => {
              setText(item.command);
              wsService.dismissRejectedCommand(sessionId, item.id);
              textareaRef.current?.focus();
              requestAnimationFrame(resizeTextarea);
            }}
          >
            Restore rejected command (replaces draft)
          </button>
          <button
            type="button"
            className="ml-2 min-h-10 underline"
            onClick={async () => {
              try {
                if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                await navigator.clipboard.writeText(item.command);
                if (sessionRef.current === sessionId)
                  setNotice({ sessionId, text: "Command copied." });
              } catch {
                if (sessionRef.current === sessionId) {
                  setNotice({
                    sessionId,
                    text: "Clipboard unavailable. Restore the command into the draft to select and copy it manually.",
                  });
                }
              }
            }}
          >
            Copy
          </button>
          <button
            type="button"
            className="ml-2 min-h-10 underline"
            onClick={() => wsService.dismissRejectedCommand(sessionId, item.id)}
          >
            Dismiss
          </button>
        </div>
      ))}
      {notice.sessionId === sessionId && notice.text && (
        <output className="mx-auto block max-w-4xl break-words px-2 text-xs text-amber-500">
          {notice.text}
        </output>
      )}
      {prefixMode === "command" && catalogStatus && (
        <div className="mx-auto max-w-4xl px-2 text-xs text-amber-500">
          {catalogStatus}{" "}
          {!catalogStatus.startsWith("Loading") && (
            <button type="button" className="min-h-10 underline" onClick={requestCatalog}>
              Retry
            </button>
          )}
        </div>
      )}
      {prefixMode === "command" && commandDecision(text).kind === "forward" && (
        <div className="mx-auto max-w-4xl px-2 text-xs text-amber-500">
          Custom or forwarded command: availability and dialogs unverified; local CLI recovery may
          be needed.
        </div>
      )}
      {showPicker && (
        <div
          ref={pickerRef}
          role="listbox"
          aria-label="Commands and skills"
          className="mx-auto mb-1 max-h-[min(12rem,30dvh)] w-full max-w-4xl overflow-y-auto overscroll-contain rounded-lg border bg-card"
        >
          {matches.map((entry, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selected}
              key={entry.id}
              onClick={() => choose(entry)}
              className={`block w-full break-words px-3 py-2 text-left text-xs ${index === selected ? "bg-accent" : ""}`}
            >
              <strong>/{entry.name}</strong> {entry.argumentHint}{" "}
              <span>
                · {entry.scope} {entry.source} · {entry.support}
              </span>
              <br />
              {entry.description}
            </button>
          ))}
        </div>
      )}
      {prefixMode && (
        <div className="mx-auto mb-1 flex w-full max-w-4xl items-center gap-1.5 px-2">
          {prefixMode === "shell" ? (
            <TerminalIcon className="size-3 shrink-0 text-amber-500" />
          ) : (
            <SlashIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span
            className={
              prefixMode === "shell" ? "text-amber-500 text-xs" : "text-muted-foreground text-xs"
            }
          >
            {inputPrefixHint(prefixMode)}
          </span>
        </div>
      )}
      <div className="mx-auto flex w-full max-w-4xl items-center gap-2 rounded-2xl border border-border/60 bg-card/80 p-2 backdrop-blur transition-colors focus-within:border-accent/40">
        {settingsSlot}
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Send a message or /command"
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            if (!text.trimStart().startsWith("/") && next.trimStart().startsWith("/"))
              requestCatalog();
            setText(next);
            setDismissed(false);
            setSelected(0);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (showPicker && e.key === "Escape") {
              e.preventDefault();
              setDismissed(true);
              return;
            }
            if (showPicker && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              const next =
                (selected + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
              setSelected(next);
              pickerRef.current
                ?.querySelectorAll<HTMLElement>('[role="option"]')
                [next]?.scrollIntoView({ block: "nearest" });
              return;
            }
            if (
              showPicker &&
              ((e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) ||
                (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey))
            ) {
              e.preventDefault();
              choose(matches[Math.min(selected, matches.length - 1)]);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e.ctrlKey || e.metaKey);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              if (queueTail) {
                // Pop the most-recent queued message back into the input so
                // the user can edit/discard it. Older queued items keep
                // waiting for their turn. The in-flight Claude turn is NOT
                // interrupted — that only happens when the queue is empty.
                setText(queueTail);
                onPopQueueTail?.();
                requestAnimationFrame(resizeTextarea);
                return;
              }
              onInterrupt?.();
              return;
            }
            if (e.key === "ArrowUp" && !text && recallText) {
              e.preventDefault();
              setText(recallText);
              // Defer height resize until after value commits.
              requestAnimationFrame(resizeTextarea);
            }
          }}
          className="min-h-8 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground/50"
        />
        <Button
          type="button"
          size="icon-sm"
          onClick={showStop ? () => onInterrupt?.() : () => send()}
          disabled={!hasText && !isProcessing}
          aria-label={showStop ? "Stop generating" : "Send"}
          className="shrink-0"
        >
          {showStop ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
        </Button>
      </div>
    </div>
  );
});
