import { Markdown } from "./Markdown";

interface AssistantMessageProps {
  text: string;
  timestamp: string;
}

export function AssistantMessage({ text, timestamp }: AssistantMessageProps) {
  return (
    <div className="group/message px-4 py-4">
      <Markdown text={text} />
      <div className="mt-2 text-[11px] text-muted-foreground/40 opacity-0 transition-opacity group-hover/message:opacity-100">
        {formatTime(timestamp)}
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
