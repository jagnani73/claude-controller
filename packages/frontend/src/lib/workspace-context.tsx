import type { DirEntry } from "common/types";
import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { useWsMessage } from "@/hooks/use-ws";
import { wsService } from "@/services/ws.service";

interface WorkspaceState {
  /**
   * The folder the sidebar picker is currently browsing. Owned here — above
   * the mobile Sheet and the desktop resizable panel — so it survives the
   * sidebar unmounting. Closing the mobile drawer (which unmounts the Sheet
   * content) no longer drops your selected folder back to the workspace root.
   *
   * Read-only to consumers: the only way to move it is `browse`, which round-
   * trips through the backend, so the rendered path always reflects a directory
   * the backend actually listed. Empty string = not yet browsed.
   */
  readonly currentPath: string;
  /** Directory entries for `currentPath`, from the latest `dir_list`. */
  readonly entries: readonly DirEntry[];
  /** Browse to a path; the `dir_list` response updates currentPath/entries. */
  browse: (path: string) => void;
  /** Workspace root, from the backend `connected` message. */
  readonly workDir: string;
  /** True when a real project folder (not the workspace root) is selected. */
  readonly isProjectFolder: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [workDir, setWorkDir] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  useWsMessage("connected", (msg) => {
    if (msg.workDir) setWorkDir(msg.workDir);
  });

  useWsMessage("dir_list", (msg) => {
    setCurrentPath(msg.path);
    setEntries(msg.entries);
  });

  const browse = useCallback((path: string) => {
    wsService.send({ type: "list_dirs", path });
  }, []);

  const isProjectFolder = !!currentPath && currentPath !== workDir;

  return (
    <WorkspaceContext.Provider
      value={{
        currentPath,
        entries,
        browse,
        workDir,
        isProjectFolder,
        searchQuery,
        setSearchQuery,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
