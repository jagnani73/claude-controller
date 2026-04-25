import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  meta?: ReactNode;
}

export function Pill({ selected, meta, className, children, ...props }: PillProps) {
  return (
    <button
      type="button"
      data-selected={selected || undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
        "border-border/60 bg-card text-muted-foreground hover:bg-accent/10 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-40",
        selected &&
          "border-accent/50 bg-accent/15 text-accent-foreground/90 hover:bg-accent/20 [&]:text-foreground",
        className,
      )}
      {...props}
    >
      <span>{children}</span>
      {meta && <span className="text-[11px] font-normal text-muted-foreground/70">{meta}</span>}
    </button>
  );
}
