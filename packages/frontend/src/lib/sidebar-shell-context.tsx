import { createContext, useContext } from "react";

export interface SidebarShellState {
  collapsed: boolean;
  expand: () => void;
  collapse: () => void;
  toggle: () => void;
}

export const SidebarShellContext = createContext<SidebarShellState | null>(null);

export function useSidebarShell(): SidebarShellState {
  const ctx = useContext(SidebarShellContext);
  if (!ctx) throw new Error("useSidebarShell must be used within SidebarShellContext");
  return ctx;
}
