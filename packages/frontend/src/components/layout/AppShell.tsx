import { Outlet, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type Layout, useGroupRef, usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { useWsMessage } from "@/hooks/use-ws";
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

/**
 * Single responsive shell. The `main` panel — and therefore the routed
 * `<Outlet/>` it wraps — is rendered unconditionally so it keeps its identity
 * (and SessionView's in-memory queue/draft state) when the viewport crosses
 * the mobile breakpoint. Only the *sidebar presentation* switches:
 *   - Desktop: a resizable panel docked beside the content (collapses to 0).
 *   - Mobile:  an off-canvas Sheet overlaying full-width content, because a
 *     resizable split can't satisfy both panels' pixel minimums on a phone.
 * The conditional sidebar panel + handle carry `order` so react-resizable-panels
 * tracks them across mount/unmount without reshuffling `main`.
 */
function ShellInner({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const sidebarRef = usePanelRef();
  const groupRef = useGroupRef();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const routerState = useRouterState();

  // Close the mobile drawer on navigation (tapping a chat / "New session").
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => setDrawerOpen(false), [routerState.location.pathname]);

  // Surface server-side errors as toasts so the user isn't left guessing.
  // 404s render a dedicated SessionView empty state, so suppress the toast
  // for those — otherwise we'd double-up.
  useWsMessage("error", (msg) => {
    if (msg.code === "session_not_found") return;
    toast.error(
      msg.message,
      msg.sessionId ? { description: `session ${msg.sessionId}` } : undefined,
    );
  });

  // Desktop resizable-panel controls (no-ops when the panel isn't mounted).
  const expandPanel = useCallback(() => sidebarRef.current?.expand(), [sidebarRef]);
  const collapsePanel = useCallback(() => sidebarRef.current?.collapse(), [sidebarRef]);
  const togglePanel = useCallback(() => {
    const handle = sidebarRef.current;
    if (!handle) return;
    if (handle.isCollapsed()) handle.expand();
    else handle.collapse();
  }, [sidebarRef]);

  useEffect(() => {
    if (!isMobile) setCollapsed(sidebarRef.current?.isCollapsed() ?? false);
  }, [isMobile, sidebarRef]);

  const onLayoutChange = useCallback(
    (next: Layout) => {
      // The mobile layout is a single full-width panel — don't let it clobber
      // the persisted desktop split.
      if (isMobile) return;
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {}
      setCollapsed(sidebarRef.current?.isCollapsed() ?? false);
    },
    [isMobile, sidebarRef],
  );

  // On mobile the sidebar is an overlay, never docked — so `collapsed` is a
  // constant true (the hamburger stays mounted) and the context drives the
  // drawer. On desktop it reflects/controls the resizable panel.
  const value = useMemo(
    () =>
      isMobile
        ? {
            collapsed: true,
            expand: () => setDrawerOpen(true),
            collapse: () => setDrawerOpen(false),
            toggle: () => setDrawerOpen((o) => !o),
          }
        : { collapsed, expand: expandPanel, collapse: collapsePanel, toggle: togglePanel },
    [isMobile, collapsed, expandPanel, collapsePanel, togglePanel],
  );

  return (
    <SidebarShellContext.Provider value={value}>
      <ResizablePanelGroup
        orientation="horizontal"
        groupRef={groupRef}
        defaultLayout={isMobile ? undefined : readLayout()}
        onLayoutChange={onLayoutChange}
        className="h-dvh w-full"
      >
        {!isMobile && (
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
        )}
        {!isMobile && (
          <ResizableHandle className="bg-sidebar-border/60 transition-colors duration-150 ease-out hover:bg-accent/40 data-[resize-handle-state=drag]:bg-accent/60" />
        )}
        {/* Always rendered — the false placeholders above keep `main` at a
            stable child index, so the routed <Outlet/> isn't remounted (and
            SessionView's queue/draft survive) when the breakpoint flips. */}
        <ResizablePanel id="main" minSize={MAIN_MIN} className="bg-background">
          {children}
        </ResizablePanel>
      </ResizablePanelGroup>

      {isMobile && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-[min(82vw,320px)] gap-0 bg-sidebar p-0 text-sidebar-foreground"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Sidebar />
          </SheetContent>
        </Sheet>
      )}
      <Toaster position="bottom-right" richColors closeButton />
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
