interface UserMessageProps {
  text: string;
  timestamp: string;
}

export function UserMessage({ text, timestamp }: UserMessageProps) {
  return (
    <div className="px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
        <span>You</span>
        <span className="text-neutral-700">{formatTime(timestamp)}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-300">
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
