interface AssistantMessageProps {
  text: string;
  timestamp: string;
}

export function AssistantMessage({ text, timestamp }: AssistantMessageProps) {
  return (
    <div className="px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span>Claude</span>
        <span className="text-neutral-700">{formatTime(timestamp)}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-100">
        {text}
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
