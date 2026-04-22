import { useEffect } from "react";
import { useDirBrowser } from "@/hooks/use-sessions";

interface FolderPickerProps {
  workDir: string;
  onPathChange: (path: string) => void;
}

export function FolderPicker({ workDir, onPathChange }: FolderPickerProps) {
  const { currentPath, entries, browse } = useDirBrowser();
  const dirs = entries.filter((e) => e.isDir);

  useEffect(() => {
    if (workDir) browse(workDir);
  }, [workDir, browse]);

  useEffect(() => {
    onPathChange(currentPath);
  }, [currentPath, onPathChange]);

  const parentPath = () => {
    const separator = currentPath.includes("/") ? "/" : "\\";
    const parts = currentPath.split(separator);
    parts.pop();
    return parts.join(separator);
  };

  const canGoUp = currentPath !== workDir && currentPath.length > workDir.length;
  const displayPath = `${currentPath || workDir}\\`;

  return (
    <div className="rounded-lg bg-neutral-900 ring-1 ring-neutral-800">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        {canGoUp && (
          <button
            type="button"
            onClick={() => browse(parentPath())}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800"
          >
            ..
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-400">
          {displayPath}
        </span>
      </div>
      <div className="max-h-40 overflow-y-auto">
        {dirs.length === 0 ? (
          <div className="px-3 py-2 text-xs text-neutral-600">No subfolders</div>
        ) : (
          dirs.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => browse(entry.path)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800"
            >
              <span className="text-neutral-600">&#128193;</span>
              {entry.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
