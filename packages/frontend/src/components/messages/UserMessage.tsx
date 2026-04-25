interface UserMessageProps {
  text: string;
  timestamp: string;
}

export function UserMessage({ text, timestamp }: UserMessageProps) {
  return (
    <div className="group/message flex justify-end px-4 py-3">
      <div className="max-w-[80%] rounded-2xl rounded-br-md border border-border/60 bg-card px-4 py-2.5">
        <div className="whitespace-pre-wrap break-words text-base leading-relaxed text-foreground/95">
          {text.trim()}
        </div>
        <div className="mt-1 text-right text-[11px] text-muted-foreground/50">
          {formatTime(timestamp)}
        </div>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
