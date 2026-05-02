import { ArrowUp } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface InputBarProps {
  onSubmit: (text: string) => void;
  /** Optional element rendered to the left of the textarea (e.g. settings popover trigger). */
  settingsSlot?: ReactNode;
}

export function InputBar({ onSubmit, settingsSlot }: InputBarProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
    // Reset the auto-grown height — the inline `style.height` set by onChange
    // persists across the value clearing, so without this the box stays tall
    // after sending a multi-line message.
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    textareaRef.current?.focus();
  };

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
            }
          }}
          className="min-h-8 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground/50"
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
