import { useNavigate } from "@tanstack/react-router";
import type { SessionConfig } from "common/types";
import { useCallback, useState } from "react";
import { Header } from "@/components/layout/Header";
import { CreateSessionForm } from "@/components/sessions/CreateSessionForm";
import { FolderPicker } from "@/components/sessions/FolderPicker";
import { RecentChats } from "@/components/sessions/RecentChats";
import { useProjectSessions, useSessions } from "@/hooks/use-sessions";
import { useWsState } from "@/hooks/use-ws";

export function HomeView() {
  const connectionState = useWsState();
  const navigate = useNavigate();
  const { workDir, createSession } = useSessions();

  const [selectedPath, setSelectedPath] = useState("");
  const [recentQuery, setRecentQuery] = useState("");
  const isProjectFolder = !!selectedPath && selectedPath !== workDir;

  const handlePathChange = useCallback((path: string) => {
    setSelectedPath(path);
    setRecentQuery("");
  }, []);

  const {
    sessions: recentChats,
    total: recentTotal,
    loading: recentLoading,
    exhausted: recentExhausted,
    loadMore: loadMoreRecent,
  } = useProjectSessions(isProjectFolder ? selectedPath : null, recentQuery);

  const openSession = (sessionId: string) => {
    navigate({ to: "/session/$sessionId", params: { sessionId } });
  };

  const handleCreate = async (config: SessionConfig) => {
    const session = await createSession(config);
    openSession(session.id);
  };

  const handleResume = async (resumeSessionId: string) => {
    const session = await createSession({
      cwd: selectedPath,
      model: "sonnet",
      permissionMode: "default",
      resumeSessionId,
    });
    openSession(session.id);
  };

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 text-white">
      <Header title="Claude Controller" connectionState={connectionState} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 py-4">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
            Project Folder
          </div>
          <FolderPicker workDir={workDir} onPathChange={handlePathChange} />
        </div>

        {isProjectFolder && (
          <>
            <div className="border-t border-neutral-800">
              <div className="px-4 pt-4 text-xs font-medium uppercase tracking-wider text-neutral-600">
                Recent Chats
                {recentTotal > 0 && (
                  <span className="ml-1 text-neutral-700">({recentTotal.toLocaleString()})</span>
                )}
              </div>
              <RecentChats
                sessions={recentChats}
                loading={recentLoading}
                exhausted={recentExhausted}
                query={recentQuery}
                onQueryChange={setRecentQuery}
                onLoadMore={loadMoreRecent}
                onOpen={handleResume}
              />
            </div>
            <div className="border-t border-neutral-800">
              <div className="px-4 pt-4 text-xs font-medium uppercase tracking-wider text-neutral-600">
                New Session
              </div>
              <CreateSessionForm cwd={selectedPath} onSubmit={handleCreate} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
