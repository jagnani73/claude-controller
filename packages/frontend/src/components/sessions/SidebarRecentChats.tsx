import type { ProjectSessionSummary } from "common/types";
import { Loader2, MessageSquare } from "lucide-react";
import { useCallback, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/utils";
import { Highlight } from "./Highlight";

interface SidebarRecentChatsProps {
  sessions: ProjectSessionSummary[];
  loading: boolean;
  exhausted: boolean;
  query: string;
  onLoadMore: () => void;
  onOpen: (sessionId: string) => void;
  activeSessionId?: string;
  resumingId?: string | null;
}

export function SidebarRecentChats({
  sessions,
  loading,
  exhausted,
  query,
  onLoadMore,
  onOpen,
  activeSessionId,
  resumingId,
}: SidebarRecentChatsProps) {
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Callback ref so the observer (re)attaches every time the sentinel mounts.
  // A useEffect([]) can't work here: on first render the sentinel isn't in the
  // DOM yet (the initial page is still loading and the sentinel is gated on
  // `!loading`), so the observer would never attach. The sentinel also unmounts
  // during each page load and remounts after — re-running this re-checks
  // intersection, so the list keeps paging until the viewport fills or the
  // list is exhausted.
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: "120px" },
    );
    io.observe(node);
    observerRef.current = io;
  }, []);

  if (sessions.length === 0 && !loading) {
    return (
      <div className="flex items-center gap-2 px-2 py-3 text-[13px] text-muted-foreground/50">
        <MessageSquare className="size-3.5" strokeWidth={1.75} />
        <span>{query ? "No matches." : "No previous chats."}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {sessions.map((s) => {
        const isActive = s.id === activeSessionId;
        const isResuming = resumingId === s.id;
        const isDisabled = !!resumingId && !isResuming;
        const fullPrompt = s.firstPrompt || "(no prompt recorded)";
        return (
          <Tooltip key={s.id} delayDuration={500}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onOpen(s.id)}
                disabled={isDisabled || isResuming}
                data-active={isActive || undefined}
                className="group flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-sidebar-accent disabled:cursor-default data-active:bg-sidebar-accent data-active:text-foreground"
              >
                <span className="flex w-full items-center gap-1.5">
                  {isResuming && <Loader2 className="size-3 shrink-0 animate-spin text-accent" />}
                  <span className="min-w-0 flex-1 truncate font-serif text-[14px] leading-tight text-foreground/90">
                    <Highlight text={fullPrompt} query={query} />
                  </span>
                </span>
                <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground/60">
                  <span>
                    {s.turnCount.toLocaleString()} turn{s.turnCount === 1 ? "" : "s"}
                  </span>
                  <span>·</span>
                  <span>{isResuming ? "spawning…" : formatRelative(s.lastModified)}</span>
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              align="start"
              sideOffset={8}
              className="max-w-sm border-border/60 bg-popover text-popover-foreground"
            >
              <div className="space-y-1.5">
                <div className="font-serif text-base leading-snug">{fullPrompt}</div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                  <span>{s.turnCount.toLocaleString()} turns</span>
                  <span>·</span>
                  <span>{formatRelative(s.lastModified)}</span>
                  <span>·</span>
                  <span className="font-mono">{s.id.slice(0, 8)}</span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
      {loading && (
        <div className="flex flex-col gap-2 px-2 py-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}
      {!exhausted && !loading && <div ref={sentinelRef} className="h-1" />}
    </div>
  );
}
