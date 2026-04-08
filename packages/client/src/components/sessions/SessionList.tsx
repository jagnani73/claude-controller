import type { SessionInfo } from "common/types";

interface SessionListProps {
    sessions: SessionInfo[];
    onSelect: (sessionId: string) => void;
    onStop: (sessionId: string) => void;
}

const statusColors: Record<string, string> = {
    running: "bg-emerald-500",
    idle: "bg-amber-500",
    waiting_for_input: "bg-amber-500",
    paused: "bg-neutral-500",
    stopped: "bg-red-500",
    error: "bg-red-500",
};

export function SessionList({ sessions, onSelect, onStop }: SessionListProps) {
    if (sessions.length === 0) {
        return (
            <div className="px-4 py-8 text-center text-neutral-500">
                No active sessions. Create one to get started.
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2 p-4">
            {sessions.map((session) => (
                <button
                    key={session.id}
                    type="button"
                    className="flex items-start gap-3 rounded-lg bg-neutral-900 p-4 text-left transition-colors active:bg-neutral-800"
                    onClick={() => onSelect(session.id)}
                >
                    <span
                        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusColors[session.status] ?? "bg-neutral-500"}`}
                    />
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-neutral-100">
                            {session.name}
                        </div>
                        <div className="mt-0.5 truncate text-sm text-neutral-500">
                            {session.cwd}
                        </div>
                        <div className="mt-1 flex gap-2 text-xs text-neutral-600">
                            <span>{session.model}</span>
                            <span>&middot;</span>
                            <span>{session.permissionMode}</span>
                        </div>
                    </div>
                    {session.status === "running" && (
                        <button
                            type="button"
                            className="shrink-0 rounded px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-400/10"
                            onClick={(e) => {
                                e.stopPropagation();
                                onStop(session.id);
                            }}
                        >
                            Stop
                        </button>
                    )}
                </button>
            ))}
        </div>
    );
}
