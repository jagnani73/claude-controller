import { useRef, useState } from "react";
import { wsService } from "@/services/ws.service";

interface InputBarProps {
  sessionId: string;
  onOpenSettings?: () => void;
}

export function InputBar({ sessionId, onOpenSettings }: InputBarProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      wsService.send({
        type: "slash_command",
        sessionId,
        command: trimmed,
      });
    } else {
      wsService.send({
        type: "input",
        sessionId,
        text: trimmed,
      });
    }
    setText("");
    inputRef.current?.focus();
  };

  return (
    <div className="shrink-0 border-t border-neutral-800 bg-neutral-950 p-3">
      <div className="flex items-center gap-2">
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Session settings"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-neutral-400 ring-1 ring-neutral-800 transition-colors active:bg-neutral-800"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
            >
              <title>Settings</title>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        <input
          ref={inputRef}
          type="text"
          placeholder="Send a message or /command"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          className="min-w-0 flex-1 rounded-lg bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
        />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim()}
          className="shrink-0 rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-950 transition-opacity disabled:opacity-30"
        >
          Send
        </button>
      </div>
    </div>
  );
}
