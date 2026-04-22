import type { ProjectSessionSummary } from "common/types";
import { useEffect, useRef, useState } from "react";
import { Highlight } from "./Highlight";

const SEARCH_DEBOUNCE_MS = 250;

interface RecentChatsProps {
  sessions: ProjectSessionSummary[];
  loading: boolean;
  exhausted: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onLoadMore: () => void;
  onOpen: (sessionId: string) => void;
}

export function RecentChats({
  sessions,
  loading,
  exhausted,
  query,
  onQueryChange,
  onLoadMore,
  onOpen,
}: RecentChatsProps) {
  const [draft, setDraft] = useState(query);

  // Debounce: commit `draft` to parent after the user pauses typing.
  useEffect(() => {
    if (draft === query) return;
    const t = setTimeout(() => onQueryChange(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, query, onQueryChange]);

  // If parent resets the query (e.g. folder changed), sync the local draft.
  useEffect(() => {
    setDraft(query);
  }, [query]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="flex flex-col">
      <div className="px-4 pb-2 pt-1">
        <input
          type="search"
          placeholder="Search by id or prompt…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
        />
      </div>

      <ul className="flex max-h-64 flex-col overflow-y-auto">
        {sessions.length === 0 && !loading && (
          <li className="px-4 py-3 text-xs text-neutral-600">
            {query ? "No matches." : "No previous chats for this folder."}
          </li>
        )}
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onOpen(s.id)}
              className="flex w-full flex-col items-start gap-1 border-b border-neutral-900 px-4 py-3 text-left transition-colors hover:bg-neutral-900 active:bg-neutral-900"
            >
              <div className="flex w-full items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                  <Highlight text={s.firstPrompt || "(no prompt recorded)"} query={query} />
                </span>
                <span className="shrink-0 text-[10px] text-neutral-600">
                  {formatRelative(s.lastModified)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-neutral-600">
                <span>
                  {s.turnCount.toLocaleString()} turn{s.turnCount === 1 ? "" : "s"}
                </span>
                <span>·</span>
                <span className="truncate font-mono">
                  <Highlight text={s.id} query={query} />
                </span>
              </div>
            </button>
          </li>
        ))}

        {loading && <li className="px-4 py-3 text-center text-xs text-neutral-600">Loading…</li>}
        {!exhausted && !loading && <div ref={sentinelRef} className="h-1" />}
      </ul>
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
