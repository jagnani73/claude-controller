import { wsService } from "@/services/ws.service";
import { useRef, useState } from "react";

interface InputBarProps {
    sessionId: string;
}

export function InputBar({ sessionId }: InputBarProps) {
    const [text, setText] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const sendInput = () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        wsService.send({
            type: "input",
            sessionId,
            data: { text: trimmed },
            timestamp: Date.now(),
        });
        setText("");
        inputRef.current?.focus();
    };

    const approve = () => {
        wsService.send({
            type: "approve",
            sessionId,
            timestamp: Date.now(),
        });
    };

    const deny = () => {
        wsService.send({
            type: "deny",
            sessionId,
            timestamp: Date.now(),
        });
    };

    return (
        <div
            className="shrink-0 border-t border-neutral-800 bg-neutral-950 p-3"
            style={{
                paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
            }}
        >
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={approve}
                    className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-opacity active:opacity-80"
                >
                    Approve
                </button>
                <button
                    type="button"
                    onClick={deny}
                    className="shrink-0 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-opacity active:opacity-80"
                >
                    Deny
                </button>
                <div className="flex min-w-0 flex-1 gap-2">
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Send input..."
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") sendInput();
                        }}
                        className="min-w-0 flex-1 rounded-lg bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
                    />
                    <button
                        type="button"
                        onClick={sendInput}
                        disabled={!text.trim()}
                        className="shrink-0 rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-950 transition-opacity disabled:opacity-30"
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
