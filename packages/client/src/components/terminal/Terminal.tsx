import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { useWsMessage } from "@/hooks/use-ws";

interface TerminalProps {
    sessionId: string;
}

export function Terminal({ sessionId }: TerminalProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);

    // Write stream data to terminal
    useWsMessage("stream", (msg) => {
        if (msg.sessionId !== sessionId) return;
        const data = msg.data as { raw: string };
        termRef.current?.write(data.raw);
    });

    useEffect(() => {
        if (!containerRef.current) return;

        const term = new XTerm({
            cursorBlink: true,
            fontSize: 14,
            fontFamily:
                "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            theme: {
                background: "#0a0a0a",
                foreground: "#e5e5e5",
                cursor: "#e5e5e5",
                selectionBackground: "#ffffff40",
            },
            convertEol: true,
            scrollback: 5000,
        });

        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        fit.fit();
        termRef.current = term;

        // Handle resize
        const resizeObserver = new ResizeObserver(() => {
            fit.fit();
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
            term.dispose();
            termRef.current = null;
        };
    }, [sessionId]);

    return <div ref={containerRef} className="w-full h-full min-h-0" />;
}
