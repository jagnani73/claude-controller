import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { PanelLeftClose, Plus, Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { SidebarFolderPicker } from "@/components/sessions/SidebarFolderPicker";
import { SidebarRecentChats } from "@/components/sessions/SidebarRecentChats";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { StatusDot } from "@/components/ui/StatusDot";
import { useProjectSessions, useSessions } from "@/hooks/use-sessions";
import { useWsState } from "@/hooks/use-ws";
import { useSidebarShell } from "@/lib/sidebar-shell-context";
import { useWorkspace } from "@/lib/workspace-context";

const SEARCH_DEBOUNCE_MS = 250;

export function Sidebar() {
  const connectionState = useWsState();
  const { workDir, createSession } = useSessions();
  const { selectedPath, setSelectedPath, searchQuery, setSearchQuery } = useWorkspace();
  const { collapse } = useSidebarShell();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const activeSessionId = params.sessionId;

  const [searchDraft, setSearchDraft] = useState(searchQuery);

  useEffect(() => {
    if (searchDraft === searchQuery) return;
    const t = setTimeout(() => setSearchQuery(searchDraft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchDraft, searchQuery, setSearchQuery]);

  const isProjectFolder = !!selectedPath && selectedPath !== workDir;
  const {
    sessions: recentChats,
    loading: recentLoading,
    exhausted: recentExhausted,
    loadMore: loadMoreRecent,
    total: recentTotal,
  } = useProjectSessions(isProjectFolder ? selectedPath : null, searchQuery);

  const handleResume = async (resumeSessionId: string) => {
    const session = await createSession({
      cwd: selectedPath,
      model: "sonnet",
      permissionMode: "default",
      resumeSessionId,
    });
    navigate({ to: "/session/$sessionId", params: { sessionId: session.id } });
  };

  const onHomeRoute = routerState.location.pathname === "/";
  const goHome = () => navigate({ to: "/" });

  const connectionTone = connectionState === "connected" ? "success" : "warning";
  const connectionLabel =
    connectionState === "connected"
      ? "Connected"
      : connectionState === "connecting"
        ? "Connecting…"
        : "Disconnected";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-sidebar-border/60 px-3 py-3">
        <button
          type="button"
          onClick={goHome}
          className="flex min-w-0 items-center gap-2 text-left transition-opacity duration-150 ease-out hover:opacity-90"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            <Sparkles className="size-3.5" strokeWidth={2} />
          </span>
          <span className="truncate font-serif text-base leading-none text-foreground">
            Claude Controller
          </span>
        </button>
        <button
          type="button"
          onClick={collapse}
          aria-label="Collapse sidebar"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-sidebar-accent hover:text-foreground"
        >
          <PanelLeftClose className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-3">
        <button
          type="button"
          onClick={goHome}
          data-active={onHomeRoute || undefined}
          className="flex w-full items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-2 text-sm font-medium text-foreground transition-colors duration-150 ease-out hover:bg-accent/15"
        >
          <Plus className="size-4 shrink-0 text-accent" strokeWidth={2} />
          <span>New session</span>
        </button>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
          <input
            type="search"
            placeholder="Search chats…"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            className="w-full rounded-md border border-sidebar-border/60 bg-sidebar-accent/40 py-1.5 pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors duration-150 ease-out focus:border-accent/40 focus:bg-sidebar-accent/60"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <SectionLabel>Directory</SectionLabel>
          <SidebarFolderPicker workDir={workDir} onPathChange={setSelectedPath} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          <SectionLabel count={isProjectFolder ? recentTotal : undefined}>
            Recent chats
          </SectionLabel>
          {isProjectFolder ? (
            <SidebarRecentChats
              sessions={recentChats}
              loading={recentLoading}
              exhausted={recentExhausted}
              query={searchQuery}
              onLoadMore={loadMoreRecent}
              onOpen={handleResume}
              activeSessionId={activeSessionId}
            />
          ) : (
            <div className="px-2 py-2 text-sm text-muted-foreground/50">
              Pick a folder to see its chats.
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-1 border-t border-sidebar-border/60 px-3 py-3">
        <StatusDot tone={connectionTone} pulse={connectionState === "connecting"}>
          <span>{connectionLabel}</span>
        </StatusDot>
        {workDir && (
          <div className="truncate font-mono text-xs text-muted-foreground/50" dir="rtl">
            {workDir}
          </div>
        )}
      </div>
    </div>
  );
}
