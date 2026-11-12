import { Loader2, Pencil, X, Zap } from "lucide-react";

/** A user submission waiting on the frontend to be sent to the backend. */
export interface QueueItem {
  id: string;
  text: string;
  /** "Send now" was tapped: the item is next, waiting for the interrupt to land. */
  sendingNow?: boolean;
}

interface QueuePanelProps {
  queue: readonly QueueItem[];
  /** Pull a queued item back into the input bar to edit/re-send it. */
  onEdit?: (id: string) => void;
  /** Drop a queued item without sending it. */
  onRemove?: (id: string) => void;
  /** Interrupt the current turn and send this item next, ahead of the rest. */
  onSendNow?: (id: string) => void;
}

/**
 * Floating panel just above the input bar that lists pending user
 * submissions. `SessionView` owns the queue state; this component just
 * renders the items it's given. Each row is tappable (the on-screen
 * equivalent of Esc-to-pop): tap the text to edit it, ⚡ to send it now
 * (interrupting the running turn), or × to discard. A row waiting on its
 * send-now interrupt shows a spinner and a "next" tag.
 */
export function QueuePanel({ queue, onEdit, onRemove, onSendNow }: QueuePanelProps) {
  if (queue.length === 0) return null;
  return (
    <div className="mx-auto mb-2 w-full max-w-4xl px-3">
      <div className="rounded-xl border border-border/60 bg-card/70 p-2 backdrop-blur">
        <div className="mb-1 flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
          <span className="size-1 rounded-full bg-warning/70" />
          <span>{queue.length} queued</span>
        </div>
        <ul className="flex max-h-40 flex-col overflow-y-auto">
          {queue.map((q) => (
            <li key={q.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onEdit?.(q.id)}
                aria-label="Edit queued message"
                className="group flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/10"
              >
                {q.sendingNow && (
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-accent">
                    next
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm text-foreground/85">
                  {q.text}
                </span>
                <Pencil className="size-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground/70" />
              </button>
              <button
                type="button"
                onClick={() => onSendNow?.(q.id)}
                disabled={q.sendingNow}
                aria-label={q.sendingNow ? "Sending next" : "Send now"}
                title={
                  q.sendingNow
                    ? "Interrupting the current turn…"
                    : "Send now: interrupt the current turn and send this next"
                }
                className="shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:text-accent disabled:text-accent"
              >
                {q.sendingNow ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onRemove?.(q.id)}
                aria-label="Remove from queue"
                className="shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
