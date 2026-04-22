import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { InputBar } from "@/components/layout/InputBar";
import { MessageStream } from "@/components/messages/MessageStream";
import { useSessions } from "@/hooks/use-sessions";
import { useWsMessage, useWsState } from "@/hooks/use-ws";

export function SessionView() {
  const { sessionId } = useParams({ from: "/session/$sessionId" });
  const navigate = useNavigate();
  const connectionState = useWsState();
  const { sessions, subscribe } = useSessions();
  const [takenOver, setTakenOver] = useState(false);

  useEffect(() => {
    setTakenOver(false);
    subscribe(sessionId);
  }, [sessionId, subscribe]);

  useWsMessage("session_taken_over", (msg) => {
    if (msg.sessionId === sessionId) setTakenOver(true);
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
      <InputBar sessionId={sessionId} />
    </div>
  );
}
