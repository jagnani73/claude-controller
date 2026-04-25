import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

interface WorkspaceState {
  selectedPath: string;
  setSelectedPath: (path: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  /**
   * Most recent path the sidebar folder picker should browse to. Bumping
   * this re-triggers the picker even when the path string didn't change
   * (e.g. clicking the home logo to "go back" to workDir).
   */
  pendingBrowse: { path: string; nonce: number } | null;
  /** Request the folder picker browse to a specific path. */
  requestBrowse: (path: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [selectedPath, setSelectedPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingBrowse, setPendingBrowse] = useState<WorkspaceState["pendingBrowse"]>(null);

  const requestBrowse = useCallback((path: string) => {
    setPendingBrowse({ path, nonce: Date.now() });
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        selectedPath,
        setSelectedPath,
        searchQuery,
        setSearchQuery,
        pendingBrowse,
        requestBrowse,
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
