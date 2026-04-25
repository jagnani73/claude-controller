import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "destructive" | "muted" | "accent";

interface StatusDotProps {
  tone?: Tone;
  pulse?: boolean;
  children?: ReactNode;
  className?: string;
}

const toneClass: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/50",
  accent: "bg-accent",
};

export function StatusDot({ tone = "muted", pulse, children, className }: StatusDotProps) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <span className="relative inline-flex h-2 w-2">
        {pulse && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              toneClass[tone],
            )}
          />
        )}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", toneClass[tone])} />
      </span>
      {children && <span className="truncate">{children}</span>}
    </span>
  );
}
