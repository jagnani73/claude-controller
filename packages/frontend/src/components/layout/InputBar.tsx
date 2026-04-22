import { useRef, useState } from "react";
import { wsService } from "@/services/ws.service";

interface InputBarProps {
  sessionId: string;
}

export function InputBar({ sessionId }: InputBarProps) {
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
    <div
      className="shrink-0 border-t border-neutral-800 bg-neutral-950 p-3"
      style={{
        paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
      }}
    >
      <div className="flex gap-2">
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
