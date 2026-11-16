import type { Terminal as XTerminal } from "@xterm/xterm";
import {
  TERMINAL_LIMITS as LIMIT,
  type TerminalClientMessage,
  type TerminalInfo,
} from "common/terminal-types";
import { useEffect, useRef, useState } from "react";
import { type ConnectionState, type TerminalSubscription, wsService } from "@/services/ws.service";

type Command = TerminalClientMessage extends infer T
  ? T extends TerminalClientMessage
    ? Omit<T, "sessionId" | "requestId">
    : never
  : never;
type Pending = { message: TerminalClientMessage; timer: ReturnType<typeof setTimeout> };
const savedSelection = new Map<string, string>();
// Retain ONLY explicit in-flight creation IDs across panel switches. Never
// resend them on mount/reconnect: Retry is an explicit user action.
const uncertainCreations = new Map<
  string,
  Extract<TerminalClientMessage, { type: "terminal_create" }>
>();

/** Lazy-compatible; mounting lists/reattaches only, it never creates a shell. */
export function TerminalPanel({ sessionId }: { sessionId: string }) {
  return <TerminalSessionPanel key={sessionId} sessionId={sessionId} />;
}

function TerminalSessionPanel({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerminal | null>(null);
  const selectedRef = useRef<string | null>(savedSelection.get(sessionId) ?? null);
  const controllerRef = useRef(false);
  const cursor = useRef(0);
  const received = useRef(0);
  const outputGeneration = useRef(0);
  const subscription = useRef<TerminalSubscription | null>(null);
  const resumeRef = useRef<() => void>(() => {});
  const pending = useRef(new Map<string, Pending>());
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(selectedRef.current);
  const [connection, setConnection] = useState<ConnectionState>(wsService.state);
  const [controller, setController] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closePending, setClosePending] = useState(false);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retryCreate, setRetryCreate] = useState(uncertainCreations.get(sessionId) ?? null);
  const [controlKey, setControlKey] = useState(false);
  const controlRef = useRef(false);
  const requestRef = useRef<(command: Command, requestId?: string) => void>(() => {});
  const fitRef = useRef<() => void>(() => {});
  const newRequest = useRef<string | null>(null);
  const closeRequest = useRef<string | null>(null);
  const current = terminals.find((entry) => entry.id === selected);

  useEffect(() => {
    let alive = true;
    const requests = pending.current;
    function finishClose(id: string | undefined) {
      if (id && closeRequest.current === id) {
        closeRequest.current = null;
        setClosePending(false);
      }
    }
    function settle(id: string | undefined) {
      if (!id) return;
      finishClose(id);
      if (uncertainCreations.get(sessionId)?.requestId === id) {
        uncertainCreations.delete(sessionId);
        setRetryCreate(null);
        setBusy(false);
      }
      const entry = requests.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      requests.delete(id);
      if (entry.message.type === "terminal_create") {
        uncertainCreations.delete(sessionId);
        setRetryCreate(null);
        setBusy(false);
      }
    }
    function request(command: Command, requestId: string = crypto.randomUUID()) {
      if (!alive) return;
      if (
        command.type === "terminal_create" &&
        !uncertainCreations.has(sessionId) &&
        uncertainCreations.size >= 100
      ) {
        setError(
          "Too many unresolved terminal creations. Resolve existing Retry creation requests first.",
        );
        setBusy(false);
        return;
      }
      if (requests.size >= 128) {
        finishClose(requestId);
        setError("Too many pending requests; wait or reconnect. Input was not queued.");
        return;
      }
      if (command.type === "terminal_subscribe") {
        const previous = subscription.current;
        subscription.current = null;
        previous?.dispose();
      }
      const message = { ...command, sessionId, requestId } as TerminalClientMessage;
      if (!wsService.sendImmediate(message)) {
        finishClose(requestId);
        setError("Disconnected or send buffer full. Input was not queued.");
        setBusy(false);
        return;
      }
      if (message.type === "terminal_subscribe") {
        subscription.current = wsService.terminalSubscription(sessionId, message.terminalId);
      }
      if (message.type === "terminal_create") {
        uncertainCreations.set(sessionId, message);
        setRetryCreate(message);
      }
      const old = requests.get(requestId);
      if (old) clearTimeout(old.timer);
      const timer = setTimeout(
        () => {
          requests.delete(requestId);
          if (!alive) return;
          finishClose(requestId);
          if (message.type === "terminal_create") setBusy(false);
          setError(
            message.type === "terminal_input"
              ? "Input acknowledgement timed out. It may have executed; it will NOT be replayed."
              : "Terminal request timed out. Reconnect to refresh; Retry creation uses the same request ID.",
          );
        },
        message.type === "terminal_create" ? 20_000 : 10_000,
      );
      requests.set(requestId, { message, timer });
    }
    requestRef.current = request;
    const unsubscribe = wsService.on("*", (message) => {
      if (
        !message.type.startsWith("terminal_") ||
        !("sessionId" in message) ||
        message.sessionId !== sessionId
      )
        return;
      if ("requestId" in message && message.type !== "terminal_error") settle(message.requestId);
      switch (message.type) {
        case "terminal_removed": {
          setTerminals((items) => items.filter((t) => t.id !== message.terminalId));
          setConfirmClose(null);
          if (selectedRef.current === message.terminalId) {
            // Invalidate output callbacks immediately; the selection effect
            // releases its subscription on the following render.
            selectedRef.current = null;
            savedSelection.delete(sessionId);
            outputGeneration.current++;
            controllerRef.current = false;
            setController(false);
            if (term.current) term.current.options.disableStdin = true;
            setSelected(null);
          }
          break;
        }
        case "terminal_list":
          setTerminals(message.terminals);
          if (selectedRef.current && !message.terminals.some((t) => t.id === selectedRef.current)) {
            selectedRef.current = null;
            setSelected(null);
            savedSelection.delete(sessionId);
            controllerRef.current = false;
            setController(false);
          }
          break;
        case "terminal_state": {
          setTerminals((entries) => [
            ...entries.filter((t) => t.id !== message.terminal.id),
            message.terminal,
          ]);

          if (message.terminal.id === selectedRef.current) {
            controllerRef.current = message.controller;
            setController(message.controller);
            if (term.current) {
              term.current.options.disableStdin = !message.controller;
              if (!message.controller)
                term.current.resize(message.terminal.cols, message.terminal.rows);
            }
            if (message.controller) fitRef.current();
          }
          // A New result is selected by its known pending request below.
          if (message.requestId && newRequest.current === message.requestId) {
            newRequest.current = null;
            savedSelection.set(sessionId, message.terminal.id);
            setSelected(message.terminal.id);
          }
          break;
        }
        case "terminal_error":
          settle(message.requestId);
          if (newRequest.current === message.requestId) newRequest.current = null;
          setError(message.message);
          if (uncertainCreations.get(sessionId)?.requestId === message.requestId) {
            uncertainCreations.delete(sessionId);
            setRetryCreate(null);
          }
          setBusy(false);
          break;
        case "terminal_gap":
          if (message.terminalId !== selectedRef.current || !term.current) break;
          outputGeneration.current++;
          subscription.current?.cancelAck();
          term.current.reset();
          cursor.current = message.available;
          received.current = message.available;
          setNotice(
            "Older output was truncated. Display resumes from the retained history; full-screen applications may need to redraw.",
          );
          break;
        case "terminal_output": {
          if (message.terminalId !== selectedRef.current || !term.current) break;
          if (message.end <= received.current) break;
          if (message.start !== received.current) {
            setError("Output sequence mismatch; reconnect to recover retained history.");
            break;
          }
          received.current = message.end;
          const generation = outputGeneration.current;
          const lease = subscription.current;
          term.current.write(message.data, () => {
            if (!alive || generation !== outputGeneration.current) return;
            cursor.current = message.end;
            if (lease === subscription.current) lease?.acknowledge(message.end);
          });
          break;
        }
      }
    });
    const resume = () => {
      const terminal = term.current;
      const id = selectedRef.current;
      const generation = outputGeneration.current;
      const socket = wsService.socketGeneration;
      if (!terminal || !id) return;
      subscription.current?.cancelAck();
      terminal.write("", () => {
        if (
          !alive ||
          term.current !== terminal ||
          selectedRef.current !== id ||
          outputGeneration.current !== generation ||
          wsService.socketGeneration !== socket ||
          wsService.state !== "connected"
        )
          return;
        received.current = cursor.current;
        request({ type: "terminal_subscribe", terminalId: id, after: cursor.current });
      });
    };
    resumeRef.current = resume;
    const reconnect = () => {
      controllerRef.current = false;
      setController(false);
      if (term.current) term.current.options.disableStdin = true;
      request({ type: "terminal_list" });
      // Drain xterm before resuming at the rendered (not received) cursor.
      resume();
    };
    const offState = wsService.onStateChange((state) => {
      setConnection(state);
      if (state === "connected") reconnect();
      else {
        const previous = subscription.current;
        subscription.current = null;
        previous?.dispose();
        controllerRef.current = false;
        setController(false);
        if (term.current) term.current.options.disableStdin = true;
      }
    });
    // A fast local WS can open between render and this effect's subscription.
    setConnection(wsService.state);
    if (wsService.state === "connected") request({ type: "terminal_list" });
    return () => {
      alive = false;
      unsubscribe();
      offState();
      for (const entry of requests.values()) clearTimeout(entry.timer);
      requests.clear();
    };
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !host.current) return;
        const terminal = new Terminal({
          cols: 80,
          rows: 24,
          scrollback: 1500,
          fontSize: 13,
          fontFamily: "JetBrains Mono Variable, monospace",
          cursorBlink: true,
          screenReaderMode: true,
          disableStdin: true,
          theme: { background: "#101318", foreground: "#e2e8f0" },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host.current);
        term.current = terminal;
        terminal.textarea?.setAttribute("aria-label", "Interactive machine terminal input");
        const data = terminal.onData((text) => {
          const id = selectedRef.current;
          if (!id || !controllerRef.current) return;
          let value = text;
          if (controlRef.current && text.length === 1) {
            value = String.fromCharCode(text.toUpperCase().charCodeAt(0) & 31);
            controlRef.current = false;
            setControlKey(false);
          }
          if (new TextEncoder().encode(value).length > LIMIT.inputBytes) {
            setError("Paste exceeds 8 KiB. Nothing was sent; paste smaller sections.");
            return;
          }
          requestRef.current({ type: "terminal_input", terminalId: id, data: value });
        });
        terminal.attachCustomKeyEventHandler((event) => {
          if (
            event.type === "keydown" &&
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "c" &&
            terminal.hasSelection()
          ) {
            event.preventDefault();
            navigator.clipboard
              .writeText(terminal.getSelection())
              .catch(() => setError("Clipboard access denied; use your browser's Copy action."));
            return false;
          }
          return true;
        });
        let resizeTimer: ReturnType<typeof setTimeout> | undefined;
        const fitTerminal = () => {
          if (disposed || !controllerRef.current) return;
          const proposed = fit.proposeDimensions();
          if (!proposed) return;
          const cols = Math.max(LIMIT.minCols, Math.min(LIMIT.maxCols, proposed.cols));
          const rows = Math.max(LIMIT.minRows, Math.min(LIMIT.maxRows, proposed.rows));
          if (cols === terminal.cols && rows === terminal.rows) return;
          terminal.resize(cols, rows);
          if (selectedRef.current)
            requestRef.current({
              type: "terminal_resize",
              terminalId: selectedRef.current,
              cols,
              rows,
            });
        };
        fitRef.current = fitTerminal;
        const observer = new ResizeObserver(() => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(fitTerminal, 150);
        });
        observer.observe(host.current);
        cleanup = () => {
          clearTimeout(resizeTimer);
          observer.disconnect();
          data.dispose();
          terminal.dispose();
          term.current = null;
          fitRef.current = () => {};
        };
        setLoaded(true);
      })
      .catch((reason) => {
        if (!disposed)
          setError(
            `Terminal renderer failed to load: ${String(reason)}. Reopen this panel to retry.`,
          );
      });
    return () => {
      disposed = true;
      outputGeneration.current++;
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (!loaded || !term.current) return;

    selectedRef.current = selected;
    setConfirmClose(null);
    controllerRef.current = false;
    setController(false);
    outputGeneration.current++;
    term.current.reset();
    term.current.options.disableStdin = true;
    cursor.current = 0;
    received.current = 0;
    setNotice("");
    if (selected) {
      savedSelection.set(sessionId, selected);
      if (savedSelection.size > 100)
        savedSelection.delete(savedSelection.keys().next().value ?? "");
      requestRef.current({ type: "terminal_subscribe", terminalId: selected, after: 0 });
    } else savedSelection.delete(sessionId);
    return () => {
      outputGeneration.current++;
      const previous = subscription.current;
      subscription.current = null;
      previous?.dispose();
    };
  }, [selected, loaded, sessionId]);

  const connected = connection === "connected";
  const buttonClass =
    "min-h-11 min-w-11 rounded border px-2 py-1 text-xs disabled:opacity-40 sm:min-h-9 sm:min-w-9";
  function create(retry = false) {
    if (busy || (uncertainCreations.has(sessionId) && !retry)) return;
    const requestId = retry && retryCreate ? retryCreate.requestId : crypto.randomUUID();
    newRequest.current = requestId;
    setBusy(true);
    setError("");
    requestRef.current(
      retry && retryCreate ? retryCreate : { type: "terminal_create", cols: 80, rows: 24 },
      requestId,
    );
  }
  function closeTerminal() {
    if (!selected || closePending) return;
    const requestId = crypto.randomUUID();
    closeRequest.current = requestId;
    setClosePending(true);
    setConfirmClose(null);
    setError("");
    requestRef.current({ type: "terminal_close", terminalId: selected }, requestId);
  }
  function key(data: string) {
    if (selected && controller)
      requestRef.current({ type: "terminal_input", terminalId: selected, data });
    term.current?.focus();
  }

  return (
    <section
      aria-label="User terminal"
      className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-auto overscroll-contain p-3 [&>*]:shrink-0"
    >
      <p className="break-words text-xs text-amber-600 dark:text-amber-400">
        Machine terminal · Commands run on the host as your user, not through Claude. This is not a
        sandbox.
      </p>
      <p className="text-xs text-muted-foreground">
        Only terminals created for this Claude session are listed. Their starting folder is the
        session workspace; changing directories inside a shell does not move it to another session.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!connected || busy || closePending || !!retryCreate}
          onClick={() => create()}
        >
          New terminal
        </button>
        {retryCreate && (
          <button
            type="button"
            className={buttonClass}
            disabled={!connected || busy}
            onClick={() => create(true)}
          >
            Retry creation
          </button>
        )}
        <select
          aria-label="Select terminal"
          className="min-h-11 min-w-0 max-w-full rounded border bg-background p-1 text-xs sm:min-h-9 sm:max-w-56"
          value={selected ?? ""}
          disabled={closePending}
          onChange={(event) => setSelected(event.target.value || null)}
        >
          <option value="">Select a terminal</option>
          {terminals.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.shell.split(/[\\/]/).pop()} · {entry.id.slice(0, 6)} · {entry.state}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={buttonClass}
          disabled={!connected}
          onClick={() => {
            setError("");
            requestRef.current({ type: "terminal_list" });
            resumeRef.current();
          }}
        >
          Reconnect
        </button>
        {selected && (
          <button
            type="button"
            className={buttonClass}
            disabled={
              !connected || current?.state !== "running" || (!controller && current.controlled)
            }
            onClick={() =>
              requestRef.current({
                type: controller ? "terminal_release" : "terminal_claim",
                terminalId: selected,
              })
            }
          >
            {controller ? "Release control" : "Take control"}
          </button>
        )}
        {selected && (
          <button
            type="button"
            className={buttonClass}
            disabled={
              !connected ||
              closePending ||
              current?.state === "closing" ||
              (current?.controlled && !controller)
            }
            onClick={() => {
              // Exited shells have nothing left to kill. Native confirm dialogs
              // may be suppressed in an embedded browser, so removal is direct
              // and running-shell confirmation is rendered inside this panel.
              if (current?.state === "exited" || current?.state === "error") closeTerminal();
              else setConfirmClose(selected);
            }}
          >
            {closePending
              ? "Working…"
              : current?.state === "exited" || current?.state === "error"
                ? "Remove"
                : current?.state === "closing"
                  ? "Closing…"
                  : "Close"}
          </button>
        )}
      </div>
      {confirmClose === selected && selected && (
        <fieldset
          className="rounded border border-amber-600/40 p-2 text-xs"
          aria-label="Confirm terminal close"
        >
          <p>Stop this shell and its jobs? Claude's session is not affected.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={!connected || closePending}
              onClick={closeTerminal}
            >
              Stop shell
            </button>
            <button type="button" className={buttonClass} onClick={() => setConfirmClose(null)}>
              Cancel
            </button>
          </div>
        </fieldset>
      )}
      <output className="min-w-0 break-words text-xs text-muted-foreground">
        {!connected
          ? `${connection} · keyboard disabled`
          : current
            ? `${current.state}${current.exitCode !== null ? ` (exit ${current.exitCode})` : ""} · ${controller ? "You control input and size" : current.controlled ? "Read-only · another viewer controls input" : "Read-only · take control to type"}`
            : "No terminal selected. New terminal explicitly starts a separate shell."}
        {current && (
          <span className="block truncate" title={current.cwd}>
            Starting folder: {current.cwd}
          </span>
        )}
      </output>
      {(error || current?.error) && (
        <p role="alert" className="break-all text-xs text-destructive">
          {error || current?.error}
        </p>
      )}
      {notice && <output className="break-words text-xs text-amber-600">{notice}</output>}
      <section
        ref={host}
        aria-label="Terminal output"
        className="min-h-40 min-w-0 flex-1 overflow-auto rounded bg-[#101318] p-1 sm:min-h-60"
      />
      <section className="flex flex-wrap gap-2" aria-label="Terminal keyboard shortcuts">
        <button
          type="button"
          className={buttonClass}
          disabled={!connected || !controller}
          onClick={() => key("\x1b")}
        >
          Esc
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!connected || !controller}
          onClick={() => key("\t")}
        >
          Tab
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!connected || !controller}
          aria-pressed={controlKey}
          onClick={() => {
            controlRef.current = !controlKey;
            setControlKey(!controlKey);
            term.current?.focus();
          }}
        >
          Ctrl
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!connected || !controller}
          onClick={() => key("\x03")}
        >
          Ctrl+C interrupt
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            const text = term.current?.getSelection();
            if (text)
              navigator.clipboard.writeText(text).catch(() => setError("Clipboard copy denied."));
            else setNotice("Select terminal text first, then Copy or Ctrl/Cmd+C.");
          }}
        >
          Copy
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!connected || !controller}
          onClick={() =>
            navigator.clipboard
              .readText()
              .then((text) => term.current?.paste(text))
              .catch(() => setError("Clipboard paste denied. Use your browser's Paste action."))
          }
        >
          Paste
        </button>
      </section>
    </section>
  );
}

export default TerminalPanel;
