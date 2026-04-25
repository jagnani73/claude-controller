import { Outlet } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type Layout, useGroupRef, usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarShellContext } from "@/lib/sidebar-shell-context";
import { WorkspaceProvider } from "@/lib/workspace-context";
import { Sidebar } from "./Sidebar";

// Pixel-based bounds give predictable behavior across viewport widths.
// Percent-based caps end up restrictive on wide monitors and finicky on small ones.
const SIDEBAR_DEFAULT = "280px";
const SIDEBAR_MIN = "220px";
const SIDEBAR_MAX = "520px";
const MAIN_MIN = "360px";
const LAYOUT_KEY = "cc-shell-layout-v2";

function readLayout(): Layout | undefined {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Layout;
  } catch {}
  return undefined;
}

function ShellInner({ children }: { children: ReactNode }) {
  const sidebarRef = usePanelRef();
  const groupRef = useGroupRef();
  const [collapsed, setCollapsed] = useState(false);

  const expand = useCallback(() => sidebarRef.current?.expand(), [sidebarRef]);
  const collapse = useCallback(() => sidebarRef.current?.collapse(), [sidebarRef]);
  const toggle = useCallback(() => {
    const handle = sidebarRef.current;
    if (!handle) return;
    if (handle.isCollapsed()) handle.expand();
    else handle.collapse();
  }, [sidebarRef]);

  // Mirror collapsed state for consumers (top bar, home view).
  useEffect(() => {
    setCollapsed(sidebarRef.current?.isCollapsed() ?? false);
  }, [sidebarRef]);

  const onLayoutChange = useCallback(
    (next: Layout) => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {}
      // Reflect collapse state via the panel handle (size === 0 ⇒ collapsed).
      setCollapsed(sidebarRef.current?.isCollapsed() ?? false);
    },
    [sidebarRef],
  );

  const defaultLayout = readLayout();

  return (
    <SidebarShellContext.Provider value={{ collapsed, expand, collapse, toggle }}>
      <ResizablePanelGroup
        orientation="horizontal"
        groupRef={groupRef}
        defaultLayout={defaultLayout}
        onLayoutChange={onLayoutChange}
        className="h-dvh w-full"
      >
        <ResizablePanel
          panelRef={sidebarRef}
          id="sidebar"
          defaultSize={SIDEBAR_DEFAULT}
          minSize={SIDEBAR_MIN}
          maxSize={SIDEBAR_MAX}
          collapsible
          collapsedSize={0}
          className="bg-sidebar text-sidebar-foreground"
        >
          <Sidebar />
        </ResizablePanel>
        <ResizableHandle className="bg-sidebar-border/60 transition-colors duration-150 ease-out hover:bg-accent/40 data-[resize-handle-state=drag]:bg-accent/60" />
        <ResizablePanel id="main" minSize={MAIN_MIN} className="bg-background">
          {children}
        </ResizablePanel>
      </ResizablePanelGroup>
    </SidebarShellContext.Provider>
  );
}

export function AppShell() {
  return (
    <TooltipProvider delayDuration={150}>
      <WorkspaceProvider>
        <ShellInner>
          <Outlet />
        </ShellInner>
      </WorkspaceProvider>
    </TooltipProvider>
  );
}
