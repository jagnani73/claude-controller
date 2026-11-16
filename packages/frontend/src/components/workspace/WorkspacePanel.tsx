import type { WorkspaceChange } from "common/types";
import {
  ArrowLeft,
  File,
  Folder,
  GitCompareArrows,
  ListChecks,
  Loader2,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { DiffView } from "./DiffView";
import { CopyPath, SourceView } from "./SourceView";
import { useWorkspaceRequest } from "./use-workspace-request";

export interface WorkspacePanelProps {
  sessionId: string;
  cwd: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Parent supplies a lazy TerminalPanel. No terminal dependency in Files/Changes. */
  terminal?: ReactNode;
  /** Read-only Claude jobs, mounted only while this tab is selected. */
  jobs?: ReactNode;
}
type Tab = "files" | "changes" | "terminal" | "jobs";
type PanelProps = { sessionId: string; revision: number };

/** Overlay only: chat, composer and its draft/queue remain mounted at every width. */
export function WorkspacePanel({
  sessionId,
  cwd,
  open,
  onOpenChange,
  terminal,
  jobs,
}: WorkspacePanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Embedded/backgrounded browsers can suspend slide-in frames offscreen. */}
      <SheetContent
        animated={false}
        side="right"
        className="w-full gap-0 p-0 sm:w-[96vw] sm:max-w-[1100px]"
      >
        {open && (
          <WorkspaceContents
            key={sessionId}
            sessionId={sessionId}
            cwd={cwd}
            terminal={terminal}
            jobs={jobs}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function WorkspaceContents({
  sessionId,
  cwd,
  terminal,
  jobs,
}: Pick<WorkspacePanelProps, "sessionId" | "cwd" | "terminal" | "jobs">) {
  const [tab, setTab] = useState<Tab>("files");
  const [revision, setRevision] = useState(0);
  return (
    <>
      <SheetHeader className="shrink-0 border-b border-border/60 pr-12">
        <SheetTitle className="font-serif text-lg">Workspace</SheetTitle>
        <SheetDescription className="truncate font-mono text-xs" title={cwd}>
          {cwd}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-1 pt-2">
          <TabButton active={tab === "files"} onClick={() => setTab("files")}>
            <Folder className="size-3.5" />
            Files
          </TabButton>
          <TabButton active={tab === "changes"} onClick={() => setTab("changes")}>
            <GitCompareArrows className="size-3.5" />
            Changes
          </TabButton>
          {terminal !== undefined && (
            <TabButton active={tab === "terminal"} onClick={() => setTab("terminal")}>
              <Terminal className="size-3.5" />
              Terminal
            </TabButton>
          )}
          {jobs !== undefined && (
            <TabButton active={tab === "jobs"} onClick={() => setTab("jobs")}>
              <ListChecks className="size-3.5" />
              Jobs
            </TabButton>
          )}
          {(tab === "files" || tab === "changes") && (
            <Button
              className="ml-auto"
              variant="ghost"
              size="icon"
              title="Refresh workspace"
              aria-label="Refresh workspace"
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw className="size-4" />
            </Button>
          )}
        </div>
      </SheetHeader>
      {tab === "files" ? (
        <FilesPanel sessionId={sessionId} revision={revision} />
      ) : tab === "changes" ? (
        <ChangesPanel sessionId={sessionId} revision={revision} />
      ) : (
        <div key={tab} className="min-h-0 flex-1">
          {tab === "terminal" ? terminal : jobs}
        </div>
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/10",
        active && "border-accent/50 bg-accent/15 text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ReadState({
  error,
  retry,
  children,
}: {
  error?: string;
  retry: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground"
      aria-live="polite"
    >
      {error ? (
        <>
          <p>{error}</p>
          <Button size="sm" variant="secondary" onClick={retry}>
            Retry
          </Button>
        </>
      ) : (
        (children ?? (
          <>
            <Loader2 className="size-5 animate-spin" />
            <p>Loading workspace…</p>
          </>
        ))
      )}
    </div>
  );
}

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const parts = path ? path.split("/") : [];
  return (
    <nav
      aria-label="Workspace directory"
      className="flex flex-wrap items-center gap-1 border-b border-border/60 px-3 py-2 text-xs"
    >
      <button
        type="button"
        className="rounded px-1 py-1 hover:bg-muted"
        onClick={() => onNavigate("")}
      >
        Workspace
      </button>
      {parts.map((part, index) => (
        <span key={parts.slice(0, index + 1).join("/")} className="flex min-w-0 items-center gap-1">
          <span className="text-muted-foreground">/</span>
          <button
            type="button"
            className="truncate rounded px-1 py-1 hover:bg-muted"
            onClick={() => onNavigate(parts.slice(0, index + 1).join("/"))}
          >
            {part}
          </button>
        </span>
      ))}
    </nav>
  );
}

function Pagination({
  offset,
  next,
  step = 200,
  onChange,
}: {
  offset: number;
  next?: number;
  step?: number;
  onChange: (offset: number) => void;
}) {
  if (!offset && next === undefined) return null;
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-border/60 px-2 py-1 text-xs">
      <Button
        size="sm"
        variant="ghost"
        disabled={!offset}
        onClick={() => onChange(Math.max(0, offset - step))}
      >
        Previous
      </Button>
      <span>Page {Math.floor(offset / step) + 1}</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={next === undefined}
        onClick={() => next !== undefined && onChange(next)}
      >
        Next
      </Button>
    </div>
  );
}

function FilesPanel({ sessionId, revision }: PanelProps) {
  const [directory, setDirectory] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const read = useWorkspaceRequest(sessionId, { kind: "list", path: directory, offset }, revision);
  function navigate(path: string) {
    setDirectory(path);
    setOffset(0);
    setSelected(null);
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Breadcrumbs path={directory} onNavigate={navigate} />
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Workspace files"
          className={cn(
            "flex min-h-0 w-full flex-col md:w-64 md:shrink-0 md:border-r md:border-border/60",
            selected && "hidden md:flex",
          )}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-3 py-1 text-xs text-muted-foreground">
            <span>Files · read-only</span>
            <CopyPath path={directory} />
          </div>
          {!read.result ? (
            <ReadState error={read.error} retry={read.retry} />
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {directory && (
                  <button
                    type="button"
                    onClick={() => navigate(directory.split("/").slice(0, -1).join("/"))}
                    className="flex w-full items-center gap-2 rounded p-2 text-left text-sm hover:bg-muted"
                  >
                    <ArrowLeft className="size-4" />
                    Parent directory
                  </button>
                )}
                {read.result.entries.length === 0 && (
                  <p className="p-4 text-sm text-muted-foreground">This directory is empty.</p>
                )}
                {read.result.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    disabled={entry.kind === "symlink" || entry.kind === "unavailable"}
                    title={
                      entry.kind === "symlink" ? "Symlink content is not available" : entry.path
                    }
                    onClick={() =>
                      entry.kind === "directory" ? navigate(entry.path) : setSelected(entry.path)
                    }
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50",
                      selected === entry.path && "bg-accent/10",
                    )}
                  >
                    {entry.kind === "directory" ? (
                      <Folder className="size-4 shrink-0 text-accent" />
                    ) : (
                      <File className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 break-all">
                      {entry.name}
                      {entry.kind === "symlink" ? " (symlink)" : ""}
                    </span>
                  </button>
                ))}
                {read.result.limited && (
                  <p className="p-3 text-xs text-warning">
                    Directory scan limited to 10,000 entries.
                  </p>
                )}
              </div>
              <Pagination offset={offset} next={read.result.nextOffset} onChange={setOffset} />
            </>
          )}
        </section>
        {selected ? (
          <FileDetail
            key={selected}
            sessionId={sessionId}
            path={selected}
            revision={revision}
            onBack={() => setSelected(null)}
          />
        ) : (
          <div className="hidden flex-1 items-center justify-center p-6 text-sm text-muted-foreground md:flex">
            Choose a file to view its source.
          </div>
        )}
      </div>
    </div>
  );
}

function FileDetail({
  sessionId,
  path,
  revision,
  onBack,
}: PanelProps & { path: string; onBack: () => void }) {
  const [lineOffset, setLineOffset] = useState(0);
  const read = useWorkspaceRequest(sessionId, { kind: "file", path, lineOffset }, revision);
  return (
    <section aria-label="Selected file" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DetailHeader path={path} onBack={onBack} />
      {!read.result ? (
        <ReadState error={read.error} retry={read.retry} />
      ) : read.result.binary ? (
        <ReadState retry={read.retry}>
          <p>Binary or non-UTF-8 file · {read.result.totalBytes.toLocaleString()} bytes</p>
          <p>Source preview is unavailable.</p>
        </ReadState>
      ) : (
        <>
          {read.result.truncated && (
            <output className="shrink-0 bg-warning/10 px-3 py-2 text-xs text-warning">
              Large file · showing only the first 256 KiB / 4,000 lines of{" "}
              {read.result.totalBytes.toLocaleString()} bytes.
            </output>
          )}
          <SourceView text={read.result.text} path={path} lineOffset={lineOffset} />
          <Pagination
            offset={lineOffset}
            next={read.result.nextLine}
            step={400}
            onChange={setLineOffset}
          />
        </>
      )}
    </section>
  );
}

const AREA_LABEL = { staged: "Staged", unstaged: "Unstaged", untracked: "Untracked" };
const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Conflict",
  T: "Type changed",
  "?": "Untracked",
};
function ChangesPanel({ sessionId, revision }: PanelProps) {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<WorkspaceChange | null>(null);
  const read = useWorkspaceRequest(sessionId, { kind: "changes", offset }, revision);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 border-b border-border/60 bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        Workspace-wide changes in this session’s directory — not attributed to Claude. Refresh to
        update.
      </p>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Workspace changes"
          className={cn(
            "flex min-h-0 w-full flex-col md:w-72 md:shrink-0 md:border-r md:border-border/60",
            selected && "hidden md:flex",
          )}
        >
          {!read.result ? (
            <ReadState error={read.error} retry={read.retry} />
          ) : !read.result.isGit ? (
            <ReadState retry={read.retry}>This workspace is not a Git worktree.</ReadState>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {read.result.entries.length === 0 && (
                  <p className="p-4 text-sm text-muted-foreground">No workspace changes.</p>
                )}
                {(["staged", "unstaged", "untracked"] as const).map((area) => (
                  <ChangeGroup
                    key={area}
                    area={area}
                    entries={read.result?.entries.filter((entry) => entry.area === area) ?? []}
                    selected={selected}
                    onSelect={setSelected}
                  />
                ))}
              </div>
              <Pagination offset={offset} next={read.result.nextOffset} onChange={setOffset} />
            </>
          )}
        </section>
        {selected ? (
          <DiffDetail
            key={`${selected.area}:${selected.path}:${revision}`}
            sessionId={sessionId}
            change={selected}
            revision={revision}
            onBack={() => setSelected(null)}
          />
        ) : (
          <div className="hidden flex-1 items-center justify-center p-6 text-sm text-muted-foreground md:flex">
            Choose a change to compare.
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeGroup({
  area,
  entries,
  selected,
  onSelect,
}: {
  area: WorkspaceChange["area"];
  entries: WorkspaceChange[];
  selected: WorkspaceChange | null;
  onSelect: (change: WorkspaceChange) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="mb-3">
      <h3 className="px-2 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {AREA_LABEL[area]} · {entries.length}
      </h3>
      {entries.map((entry) => (
        <button
          key={entry.path}
          type="button"
          onClick={() => onSelect(entry)}
          className={cn(
            "flex w-full items-start gap-2 rounded p-2 text-left text-sm hover:bg-muted",
            selected?.path === entry.path && selected.area === area && "bg-accent/10",
          )}
        >
          <span
            className="mt-0.5 rounded border border-border px-1 font-mono text-xs text-muted-foreground"
            title={STATUS_LABEL[entry.status] ?? entry.status}
          >
            {entry.status}
          </span>
          <span className="min-w-0 break-all">
            <span>{entry.path}</span>
            {entry.oldPath && (
              <span className="block text-xs text-muted-foreground">from {entry.oldPath}</span>
            )}
            <span className="block text-xs text-muted-foreground">
              {STATUS_LABEL[entry.status] ?? entry.status}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function DetailHeader({
  path,
  onBack,
  label,
}: {
  path: string;
  onBack: () => void;
  label?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
      <Button size="icon" variant="ghost" onClick={onBack} aria-label="Back to list">
        <ArrowLeft className="size-4" />
      </Button>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs" title={path}>
          {path}
        </p>
        {label && <p className="text-xs text-muted-foreground">{label}</p>}
      </div>
      <CopyPath path={path} />
    </div>
  );
}
function DiffDetail({
  sessionId,
  change,
  revision,
  onBack,
}: PanelProps & { change: WorkspaceChange; onBack: () => void }) {
  const read = useWorkspaceRequest(
    sessionId,
    { kind: "diff", path: change.path, area: change.area },
    revision,
  );
  return (
    <section aria-label="Selected diff" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DetailHeader
        path={change.path}
        onBack={onBack}
        label={`${AREA_LABEL[change.area]} · ${STATUS_LABEL[change.status] ?? change.status}`}
      />
      {read.result ? (
        <DiffView diff={read.result} />
      ) : (
        <ReadState error={read.error} retry={read.retry} />
      )}
    </section>
  );
}
