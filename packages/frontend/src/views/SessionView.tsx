import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { InputBar } from "@/components/layout/InputBar";
import { SessionTopBar } from "@/components/layout/SessionTopBar";
import { StatusLine } from "@/components/layout/StatusLine";
import { MessageStream } from "@/components/messages/MessageStream";
import { SessionSettingsSheet } from "@/components/sessions/SessionSettingsSheet";
import { Button } from "@/components/ui/button";
import { useSessions } from "@/hooks/use-sessions";
import { useWsMessage } from "@/hooks/use-ws";

export function SessionView() {
  const { sessionId } = useParams({ from: "/session/$sessionId" });
  const navigate = useNavigate();
  const { sessions, subscribe, cyclePermissionMode, setModel, setEffort } = useSessions();
  const [takenOver, setTakenOver] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusLine, setStatusLine] = useState("");

  useEffect(() => {
    setTakenOver(false);
    setStatusLine("");
    subscribe(sessionId);
  }, [sessionId, subscribe]);

  useWsMessage("session_taken_over", (msg) => {
    if (msg.sessionId === sessionId) setTakenOver(true);
  });

  useWsMessage("status_line", (msg) => {
    if (msg.sessionId === sessionId) setStatusLine(msg.text);
  });

  const session = sessions.find((s) => s.id === sessionId);
  const goHome = () => navigate({ to: "/" });

  if (takenOver) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="font-serif text-lg text-foreground">Session in use elsewhere</p>
        <p className="max-w-md text-base text-muted-foreground">
          This session was opened on another device. Stream paused here to keep it exclusive.
        </p>
        <div className="flex gap-2">
          <Button variant="default" onClick={goHome}>
            Back to Home
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setTakenOver(false);
              subscribe(sessionId);
            }}
          >
            Reclaim here
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <SessionTopBar
        title={session?.name ?? "Session"}
        cwd={session?.cwd}
        model={session?.model}
        currentModelId={session?.currentModelId}
        permissionMode={session?.permissionMode}
        effort={session?.effort}
      />
      <div className="min-h-0 flex-1">
        <MessageStream sessionId={sessionId} />
      </div>
      <div className="relative" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {settingsOpen && session && (
          <SessionSettingsSheet
            session={session}
            onClose={() => setSettingsOpen(false)}
            onSetModel={(m) => setModel(sessionId, m)}
            onSetEffort={(e) => setEffort(sessionId, e)}
            onCyclePermissionMode={() => cyclePermissionMode(sessionId)}
          />
        )}
        <InputBar
          sessionId={sessionId}
          onOpenSettings={session ? () => setSettingsOpen((o) => !o) : undefined}
        />
        <StatusLine text={statusLine} />
      </div>
    </div>
  );
}
