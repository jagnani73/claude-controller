import { ChevronRight, Folder } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useDirBrowser } from "@/hooks/use-sessions";
import { cn } from "@/lib/utils";

interface SidebarFolderPickerProps {
  workDir: string;
  onPathChange: (path: string) => void;
}

interface Crumb {
  label: string;
  path: string;
}

function splitCrumbs(workDir: string, currentPath: string): Crumb[] {
  if (!workDir) return [];
  const sep = currentPath.includes("/") && !currentPath.includes("\\") ? "/" : "\\";
  const root = workDir.replace(/[\\/]+$/, "");
  const rest = currentPath.startsWith(root) ? currentPath.slice(root.length) : "";
  const segments = rest.split(/[\\/]/).filter(Boolean);
  const crumbs: Crumb[] = [{ label: lastSegment(root) || root, path: root }];
  let acc = root;
  for (const seg of segments) {
    acc = `${acc}${sep}${seg}`;
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs;
}

function lastSegment(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function SidebarFolderPicker({ workDir, onPathChange }: SidebarFolderPickerProps) {
  const { currentPath, entries, browse } = useDirBrowser();
  const dirs = entries.filter((e) => e.isDir);

  useEffect(() => {
    if (workDir) browse(workDir);
  }, [workDir, browse]);

  useEffect(() => {
    onPathChange(currentPath);
  }, [currentPath, onPathChange]);

  const crumbs = useMemo(() => splitCrumbs(workDir, currentPath), [workDir, currentPath]);

  return (
    <div className="flex flex-col gap-1">
      {crumbs.length > 0 && (
        <div className="flex flex-wrap items-center gap-0.5 px-1 py-0.5 text-[12px]">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable per render
              <div key={`${c.path}-${i}`} className="flex items-center gap-0.5">
                {i > 0 && <ChevronRight className="size-3 text-muted-foreground/40" />}
                <button
                  type="button"
                  onClick={() => browse(c.path)}
                  disabled={isLast}
                  className={cn(
                    "rounded px-1 py-0.5 font-mono transition-colors duration-150 ease-out",
                    isLast
                      ? "cursor-default text-foreground"
                      : "text-muted-foreground/70 hover:bg-sidebar-accent hover:text-foreground",
                  )}
                >
                  {c.label}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {dirs.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-muted-foreground/40">No subfolders</div>
        ) : (
          dirs.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => browse(entry.path)}
              className="group flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-foreground/80 transition-colors duration-150 ease-out hover:bg-sidebar-accent hover:text-foreground"
            >
              <Folder
                className="size-3.5 shrink-0 text-muted-foreground/50 transition-colors duration-150 ease-out group-hover:text-accent/80"
                strokeWidth={1.75}
              />
              <span className="truncate">{entry.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
