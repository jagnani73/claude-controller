import { PanelLeftOpen } from "lucide-react";
import { useSidebarShell } from "@/lib/sidebar-shell-context";
import { cn } from "@/lib/utils";

// The "show sidebar" affordance, shared by HomeView and SessionTopBar.
// Renders only when the sidebar is collapsed/hidden; opens it on click.
export function SidebarToggle({ className }: { className?: string }) {
  const { collapsed, expand } = useSidebarShell();
  if (!collapsed) return null;
  return (
    <button
      type="button"
      // Stop the click from bubbling to an interactive parent (e.g. the
      // SessionTopBar row that toggles the meta disclosure on tap).
      onClick={(e) => {
        e.stopPropagation();
        expand();
      }}
      aria-label="Show sidebar"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-card hover:text-foreground",
        className,
      )}
    >
      <PanelLeftOpen className="size-4" strokeWidth={1.75} />
    </button>
  );
}
