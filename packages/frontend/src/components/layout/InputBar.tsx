import { ArrowUp, Square } from "lucide-react";
import { forwardRef, type ReactNode, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export interface InputBarHandle {
  /** Replace the textarea contents and focus it. Used by QueuePanel "edit" taps. */
  loadDraft: (text: string) => void;
}

interface InputBarProps {
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
  { onSubmit, settingsSlot, recallText, queueTail, onPopQueueTail, onInterrupt, isProcessing },
  ref,
) {
  const [text, setText] = useState("");
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

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = lastSentRef.current;
    const now = Date.now();
    if (last && last.text === trimmed && now - last.at < SAME_TEXT_DEDUP_MS) {
      // One physical action fired twice (touch+click on mobile, autorepeated
      // keydown, etc.). Drop the second so we don't enqueue or send a
      // duplicate the user didn't intend.
      return;
    }
    lastSentRef.current = { text: trimmed, at: now };
    onSubmit(trimmed);
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

  return (
    <div className="mb-2 shrink-0 px-3 pb-2 pt-1">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-2 rounded-2xl border border-border/60 bg-card/80 p-2 backdrop-blur transition-colors focus-within:border-accent/40">
        {settingsSlot}
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Send a message or /command"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
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
          onClick={showStop ? () => onInterrupt?.() : send}
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
