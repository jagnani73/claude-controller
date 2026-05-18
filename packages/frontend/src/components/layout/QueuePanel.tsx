/** A user submission waiting on the frontend to be sent to the backend. */
export interface QueueItem {
  id: string;
  text: string;
}

interface QueuePanelProps {
  queue: readonly QueueItem[];
}

/**
 * Floating panel just above the input bar that lists pending user
 * submissions. `SessionView` owns the queue state; this component just
 * renders the items it's given.
 */
export function QueuePanel({ queue }: QueuePanelProps) {
  if (queue.length === 0) return null;
  return (
    <div className="mx-auto mb-2 w-full max-w-4xl px-3">
      <div className="rounded-xl border border-border/60 bg-card/70 p-2 backdrop-blur">
        <div className="mb-1 flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
          <span className="size-1 rounded-full bg-warning/70" />
          <span>{queue.length} queued</span>
        </div>
        <ul className="flex flex-col">
          {queue.map((q) => (
            <li key={q.id} className="truncate px-1 py-0.5 text-sm text-foreground/85">
              {q.text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
