import type { ShellJob, ShellJobServerMessage } from "common/shell-job-types";
import { useEffect, useRef, useState } from "react";
import { wsService } from "@/services/ws.service";

type Output = Extract<ShellJobServerMessage, { type: "shell_job_output" }>;
const DISPLAY_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 6000;

/** One in-flight request per channel, shared by refresh, polling and reconnect. */
function requestGate(onTimeout: () => void) {
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    pending = undefined;
  };
  return {
    start() {
      if (pending) return undefined;
      pending = crypto.randomUUID();
      timer = setTimeout(() => {
        cancel();
        onTimeout();
      }, REQUEST_TIMEOUT_MS);
      return pending;
    },
    accept(id: string | undefined) {
      if (!pending || id !== pending) return false;
      cancel();
      return true;
    },
    cancel,
  };
}

/** Read-only Claude jobs, not a terminal. Mount only while the workspace tab is open. */
export function ShellJobsPanel({ sessionId }: { sessionId: string }) {
  const [jobs, setJobs] = useState<ShellJob[]>([]);
  const [selected, setSelected] = useState("");
  const [output, setOutput] = useState<Output | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [limited, setLimited] = useState(false);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState("");
  const [outputError, setOutputError] = useState("");
  const [outputLoading, setOutputLoading] = useState(false);
  const requestSnapshot = useRef(() => {});
  const requestOutput = useRef(() => {});
  const pane = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setJobs([]);
    setSelected("");
    setLoading(true);
    setError("");
    setLimited(false);
    const gate = requestGate(() => {
      setLoading(false);
      setError("Jobs request timed out. Use Refresh / retry.");
    });
    const request = () => {
      if (wsService.state !== "connected") {
        setLoading(false);
        setError("Disconnected. Jobs will retry after reconnecting.");
        return;
      }
      const requestId = gate.start();
      if (requestId) wsService.send({ type: "shell_jobs_request", sessionId, requestId });
    };
    requestSnapshot.current = request;
    const off = wsService.on("shell_jobs_snapshot", (msg) => {
      if (
        msg.type !== "shell_jobs_snapshot" ||
        msg.sessionId !== sessionId ||
        !gate.accept(msg.requestId)
      )
        return;
      setJobs(msg.jobs);
      setLimited(msg.truncated);
      setError(msg.error ?? "");
      setLoading(false);
    });
    const stopped = wsService.on("session_stopped", (msg) => {
      if (msg.type !== "session_stopped" || msg.sessionId !== sessionId) return;
      setFollow(false);
      setError("Session stopped. Resume the session to reconstruct its jobs.");
      setJobs((previous) =>
        previous.map((job) => (job.status === "running" ? { ...job, status: "unknown" } : job)),
      );
    });
    const connection = wsService.onStateChange((state) => {
      gate.cancel();
      if (state !== "connected") {
        setLoading(false);
        setError("Disconnected. Jobs will retry after reconnecting.");
      }
      // Periodic snapshots retry after the owning view re-subscribes.
    });
    request();
    const timer = setInterval(request, 2000);
    return () => {
      off();
      stopped();
      connection();
      gate.cancel();
      requestSnapshot.current = () => {};
      clearInterval(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    setOutput(null);
    setOutputError("");
    setOutputLoading(false);
    setCopied("");
    if (!selected) return;
    let cursor: number | undefined;
    const gate = requestGate(() => {
      setOutputLoading(false);
      setOutputError("Output request timed out. Use Refresh / retry.");
    });
    const request = () => {
      if (wsService.state !== "connected") {
        setOutputLoading(false);
        setOutputError("Disconnected. Output will retry after reconnecting.");
        return;
      }
      const requestId = gate.start();
      if (!requestId) return;
      setOutputLoading(true);
      wsService.send({
        type: "shell_job_output_request",
        sessionId,
        jobId: selected,
        offset: cursor,
        requestId,
      });
    };
    requestOutput.current = request;
    const off = wsService.on("shell_job_output", (msg) => {
      if (
        msg.type !== "shell_job_output" ||
        msg.sessionId !== sessionId ||
        msg.jobId !== selected ||
        !gate.accept(msg.requestId)
      )
        return;
      setOutputLoading(false);
      setOutputError(msg.error ? `${msg.error} Use Refresh / retry.` : "");
      if (!msg.error) cursor = msg.offset;
      setOutput((previous) => {
        const combined = msg.error
          ? (previous?.text ?? "")
          : (msg.reset ? "" : (previous?.text ?? "")) + msg.text;
        return {
          ...msg,
          text: combined.slice(-DISPLAY_LIMIT),
          truncated:
            msg.truncated ||
            combined.length > DISPLAY_LIMIT ||
            (!msg.reset && !!previous?.truncated),
        };
      });
    });
    // A reconnect may precede the parent's async subscription. Retry once its
    // initial history marker arrives too, including when Follow is disabled.
    let reconnecting = wsService.state !== "connected";
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const retryConnected = () => {
      clearTimeout(reconnectTimer);
      // Respect the server's 500ms throttle; don't race snapshot readiness.
      reconnectTimer = setTimeout(request, 750);
    };
    const ready = wsService.on("history_available", (msg) => {
      if (msg.type !== "history_available" || msg.sessionId !== sessionId || !reconnecting) return;
      reconnecting = false;
      gate.cancel();
      retryConnected();
    });
    const connection = wsService.onStateChange((state) => {
      gate.cancel();
      clearTimeout(reconnectTimer);
      if (state !== "connected") {
        reconnecting = true;
        setOutputLoading(false);
        setOutputError("Disconnected. Output will retry after reconnecting.");
      } else {
        retryConnected();
      }
    });
    request();
    return () => {
      off();
      ready();
      connection();
      clearTimeout(reconnectTimer);
      gate.cancel();
      requestOutput.current = () => {};
    };
  }, [sessionId, selected]);

  useEffect(() => {
    if (!follow) return;
    const timer = setInterval(() => requestOutput.current(), 1500);
    return () => clearInterval(timer);
  }, [follow]);

  useEffect(() => {
    if (follow && output && pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }, [follow, output]);

  const refresh = () => {
    requestSnapshot.current();
    requestOutput.current();
  };
  const job = jobs.find((item) => item.id === selected);
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-auto overscroll-contain p-3 sm:p-4 [&>*]:shrink-0"
      aria-label="Claude shell jobs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Claude shell jobs</h2>
        <button
          type="button"
          className="min-h-11 rounded border px-3 py-1 text-sm sm:min-h-9"
          onClick={refresh}
        >
          Refresh / retry
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Read-only background Bash output. Not a native terminal; input and stopping are unavailable.
      </p>
      {error && <output className="break-all text-sm text-destructive">{error}</output>}
      {loading ? (
        <p>Loading jobs…</p>
      ) : (
        !error &&
        jobs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No verified shell jobs found. Refresh after Claude launches one.
          </p>
        )
      )}
      {limited && (
        <p className="text-xs">Job list capped at 128 entries; additional jobs are not tracked.</p>
      )}
      <div className="flex flex-col gap-2">
        {jobs.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected === item.id}
            onClick={() => setSelected(item.id)}
            className="min-h-11 min-w-0 break-all rounded border p-2 text-left text-sm aria-pressed:bg-muted"
          >
            <span className="font-medium">{item.description || item.command || item.id}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {item.status} · {item.source}
            </span>
          </button>
        ))}
      </div>
      {job && (
        <>
          <dl className="break-all text-xs text-muted-foreground">
            <dt>Command</dt>
            <dd className="whitespace-pre-wrap font-mono text-foreground">
              {job.command || "Unavailable"}
            </dd>
            <dt>Session-context cwd (not necessarily child cwd)</dt>
            <dd>{job.contextCwd}</dd>
            <dt>Job / original tool</dt>
            <dd>
              {job.id} / {job.toolUseId}
            </dd>
            <dt>Exit code</dt>
            <dd>Unavailable</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <label className="flex min-h-11 items-center gap-2 sm:min-h-9">
              <input
                type="checkbox"
                className="size-5"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              Follow output
            </label>
            <button
              type="button"
              disabled={!output?.text}
              className="min-h-11 rounded px-2 sm:min-h-9"
              onClick={() => {
                void navigator.clipboard.writeText(output?.text ?? "").then(
                  () => setCopied("Copied"),
                  () => setCopied("Copy failed"),
                );
              }}
            >
              Copy visible output
            </button>
            <output>{copied}</output>
          </div>
          {outputError && (
            <output className="break-all text-sm text-destructive">{outputError}</output>
          )}
          {outputLoading && <p className="text-xs">Loading output…</p>}
          {output?.truncated && (
            <p className="text-xs text-muted-foreground">
              Earlier output omitted; showing a bounded tail.
            </p>
          )}
          <pre
            ref={pane}
            className="min-h-32 min-w-0 max-h-96 overflow-auto overscroll-contain rounded border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-all"
          >
            {output?.text ||
              (outputError
                ? "Output unavailable."
                : output
                  ? "No output yet."
                  : "Waiting for output…")}
          </pre>
        </>
      )}
    </section>
  );
}
