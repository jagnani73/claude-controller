import { createContext, type ReactNode, useContext, useState } from "react";

interface WorkspaceState {
  selectedPath: string;
  setSelectedPath: (path: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [selectedPath, setSelectedPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  return (
    <WorkspaceContext.Provider
      value={{ selectedPath, setSelectedPath, searchQuery, setSearchQuery }}
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
