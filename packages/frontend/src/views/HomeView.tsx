import { useNavigate } from "@tanstack/react-router";
import type { SessionConfig } from "common/types";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { SidebarToggle } from "@/components/layout/SidebarToggle";
import { CreateSessionForm } from "@/components/sessions/CreateSessionForm";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSessions } from "@/hooks/use-sessions";
import { useWorkspace } from "@/lib/workspace-context";

export function HomeView() {
  const navigate = useNavigate();
  const { workDir, createSession } = useSessions();
  const { selectedPath } = useWorkspace();

  const isProjectFolder = !!selectedPath && selectedPath !== workDir;

  const handleCreate = async (config: SessionConfig) => {
    try {
      const session = await createSession(config);
      navigate({ to: "/session/$sessionId", params: { sessionId: session.id } });
    } catch (err) {
      toast.error("Couldn't create session", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <SidebarToggle className="m-2" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-12 md:py-20">
          <header className="space-y-2">
            <h1 className="font-serif text-3xl text-foreground">Start a new session</h1>
            <p className="text-base text-muted-foreground">
              {isProjectFolder
                ? "Configure how Claude Code will run, then create the session."
                : "Pick a project folder in the sidebar to get started."}
            </p>
          </header>

          {isProjectFolder ? (
            <CreateSessionForm cwd={selectedPath} onSubmit={handleCreate} />
          ) : (
            <EmptyState
              icon={FolderOpen}
              title="No folder selected"
              description="Use the sidebar to browse to a project folder. Past chats and the new-session form will appear here."
            />
          )}
        </div>
      </div>
    </div>
  );
}
