import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionLabelProps {
  children: ReactNode;
  count?: number;
  className?: string;
}

export function SectionLabel({ children, count, className }: SectionLabelProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground/70",
        className,
      )}
    >
      <span>{children}</span>
      {count !== undefined && <span className="text-muted-foreground/50">({count})</span>}
    </div>
  );
}
