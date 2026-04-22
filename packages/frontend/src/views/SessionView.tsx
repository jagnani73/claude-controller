import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { InputBar } from "@/components/layout/InputBar";
import { StatusLine } from "@/components/layout/StatusLine";
import { MessageStream } from "@/components/messages/MessageStream";
import { SessionSettingsSheet } from "@/components/sessions/SessionSettingsSheet";
import { useSessions } from "@/hooks/use-sessions";
import { useWsMessage, useWsState } from "@/hooks/use-ws";

export function SessionView() {
  const { sessionId } = useParams({ from: "/session/$sessionId" });
  const navigate = useNavigate();
  const connectionState = useWsState();
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
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-white">
        <div className="text-sm text-neutral-400">
          This session was opened on another device. Stream paused here to keep it exclusive.
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={goHome}
            className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition-opacity active:opacity-80"
          >
            Back to Home
          </button>
          <button
            type="button"
            onClick={() => {
              setTakenOver(false);
              subscribe(sessionId);
            }}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-200 ring-1 ring-neutral-800 transition-opacity active:opacity-80"
          >
            Reclaim here
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 text-white">
      <Header
        title={session?.name ?? "Session"}
        connectionState={connectionState}
        showBack
        onBack={goHome}
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
