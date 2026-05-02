import { Link, useParams } from "@tanstack/react-router";
import { Loader2, SearchX } from "lucide-react";
import { useEffect, useState } from "react";
import { InputBar } from "@/components/layout/InputBar";
import { SessionTopBar } from "@/components/layout/SessionTopBar";
import { StatusLine } from "@/components/layout/StatusLine";
import { MessageStream } from "@/components/messages/MessageStream";
import { SessionSettingsPopover } from "@/components/sessions/SessionSettingsPopover";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSessions } from "@/hooks/use-sessions";
import { useWsMessage } from "@/hooks/use-ws";
import { useWorkspace } from "@/lib/workspace-context";

export function SessionView() {
  const { sessionId } = useParams({ from: "/session/$sessionId" });
  const { sessions, subscribe, updateSettings, submitInput } = useSessions();
  const { requestBrowse } = useWorkspace();
  const [takenOver, setTakenOver] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [statusLine, setStatusLine] = useState("");

  useEffect(() => {
    setTakenOver(false);
    setNotFound(false);
    setStatusLine("");
    subscribe(sessionId);
  }, [sessionId, subscribe]);

  useWsMessage("session_taken_over", (msg) => {
    if (msg.sessionId === sessionId) setTakenOver(true);
  });

  useWsMessage("status_line", (msg) => {
    if (msg.sessionId === sessionId) setStatusLine(msg.text);
  });

  useWsMessage("error", (msg) => {
    if (msg.sessionId === sessionId && msg.code === "session_not_found") setNotFound(true);
  });

  const session = sessions.find((s) => s.id === sessionId);

  // Once we know the session's workdir, point the sidebar folder picker at it
  // so the surrounding context matches what the user is viewing.
  useEffect(() => {
    if (session?.cwd) requestBrowse(session.cwd);
  }, [session?.cwd, requestBrowse]);

  if (notFound) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center px-6">
        <EmptyState
          icon={SearchX}
          title="Session not found"
          description={
            <span>
              No transcript exists for{" "}
              <span className="font-mono text-foreground/80">{sessionId.slice(0, 8)}…</span> on this
              backend. It may have been started elsewhere or the id is mistyped.
            </span>
          }
          action={
            <Button asChild>
              <Link to="/">Back to Home</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (takenOver) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="font-serif text-lg text-foreground">Session in use elsewhere</p>
        <p className="max-w-md text-base text-muted-foreground">
          This session was opened on another device. Stream paused here to keep it exclusive.
        </p>
        <div className="flex gap-2">
          <Button variant="default" asChild>
            <Link to="/">Back to Home</Link>
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

  // Until we have a session in memory, show a tiny loader. Direct-nav flows
  // can take a beat (disk scan + auto-resume + transcript drain).
  if (!session) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-accent" />
        <p className="mt-3 font-serif text-base italic">Opening session…</p>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <SessionTopBar session={session} />
      <div className="min-h-0 flex-1">
        <MessageStream sessionId={sessionId} />
      </div>
      <div className="relative" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <InputBar
          onSubmit={(text) => submitInput(sessionId, text)}
          settingsSlot={
            <SessionSettingsPopover
              session={session}
              onChange={(next) => updateSettings(sessionId, next)}
            />
          }
        />
        <StatusLine text={statusLine} />
      </div>
    </div>
  );
}
