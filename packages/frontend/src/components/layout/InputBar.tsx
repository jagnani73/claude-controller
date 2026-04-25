import { ArrowUp, Settings2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { wsService } from "@/services/ws.service";

interface InputBarProps {
  sessionId: string;
  onOpenSettings?: () => void;
}

export function InputBar({ sessionId, onOpenSettings }: InputBarProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      wsService.send({ type: "slash_command", sessionId, command: trimmed });
    } else {
      wsService.send({ type: "input", sessionId, text: trimmed });
    }
    setText("");
    textareaRef.current?.focus();
  };

  return (
    <div className="shrink-0 px-3 pb-2 pt-1">
      <div className="mx-auto flex w-full max-w-4xl items-end gap-2 rounded-2xl border border-border/60 bg-card/80 p-2 backdrop-blur transition-colors focus-within:border-accent/40">
        {onOpenSettings && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSettings}
            aria-label="Session settings"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="size-4" />
          </Button>
        )}
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
            }
          }}
          className="min-h-[36px] min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground/50"
        />
        <Button
          type="button"
          size="icon-sm"
          onClick={send}
          disabled={!text.trim()}
          aria-label="Send"
          className="shrink-0"
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
