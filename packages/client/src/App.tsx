import { Header } from "@/components/layout/Header";
import { InputBar } from "@/components/layout/InputBar";
import { CreateSessionForm } from "@/components/sessions/CreateSessionForm";
import { SessionList } from "@/components/sessions/SessionList";
import { Terminal } from "@/components/terminal/Terminal";
import { useSessions } from "@/hooks/use-sessions";
import { useWsConnection, useWsState } from "@/hooks/use-ws";

export function App() {
    useWsConnection();
    const connectionState = useWsState();
    const {
        sessions,
        activeSession,
        activeSessionId,
        workDir,
        createSession,
        stopSession,
        subscribe,
        unsubscribe,
    } = useSessions();

    // Active session view
    if (activeSessionId) {
        return (
            <div className="flex h-dvh flex-col bg-neutral-950 text-white">
                <Header
                    title={activeSession?.name ?? "Session"}
                    connectionState={connectionState}
                    showBack
                    onBack={unsubscribe}
                />
                <div className="min-h-0 flex-1">
                    <Terminal sessionId={activeSessionId} />
                </div>
                <InputBar sessionId={activeSessionId} />
            </div>
        );
    }

    // Session list view
    return (
        <div className="flex h-dvh flex-col bg-neutral-950 text-white">
            <Header
                title="Claude Controller"
                connectionState={connectionState}
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
                <SessionList
                    sessions={sessions}
                    onSelect={subscribe}
                    onStop={stopSession}
                />
                <div className="border-t border-neutral-800">
                    <div className="px-4 pt-4 text-xs font-medium uppercase tracking-wider text-neutral-600">
                        New Session
                    </div>
                    <CreateSessionForm
                        workDir={workDir}
                        onSubmit={createSession}
                    />
                </div>
            </div>
        </div>
    );
}
