import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  size?: "sm" | "md";
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  size = "md",
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "md" ? "gap-3 px-6 py-16" : "gap-2 px-4 py-8",
        className,
      )}
    >
      {Icon && (
        <Icon
          className={cn("text-muted-foreground/40", size === "md" ? "size-10" : "size-6")}
          strokeWidth={1.5}
        />
      )}
      <div className="space-y-1">
        <div
          className={cn("font-serif text-foreground/90", size === "md" ? "text-xl" : "text-base")}
        >
          {title}
        </div>
        {description && <div className="text-base text-muted-foreground">{description}</div>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
