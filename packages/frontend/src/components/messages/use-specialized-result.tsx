import type { ToolResult } from "common/types";
import { useEffect, useState } from "react";
import { fetchToolResult } from "@/services/tool-result.service";

/** Explicitly hydrate on demand; never decode a potentially partial answer. */
export function useSpecializedResult(
  sessionId: string,
  toolUseId: string,
  preview: ToolResult | null | undefined,
) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    source: ToolResult;
    result?: ToolResult;
    failure?: string;
  } | null>(null);
  useEffect(() => {
    if (!preview?.preview || attempt === 0) return;
    let active = true;
    setLoaded(null);
    void fetchToolResult(sessionId, toolUseId)
      .then((outcome) => {
        if (!active) return;
        setLoaded(
          outcome.status === "available"
            ? { source: preview, result: { value: outcome.result, isError: outcome.isError } }
            : { source: preview, failure: "Full result unavailable: it is no longer retained." },
        );
      })
      .catch((error: unknown) => {
        if (active)
          setLoaded({
            source: preview,
            failure: error instanceof Error ? error.message : "Could not load full result.",
          });
      });
    return () => {
      active = false;
    };
  }, [sessionId, toolUseId, preview, attempt]);
  const current = loaded?.source === preview ? loaded : null;
  const result = current?.result ?? preview;
  const incomplete = !!result?.preview;
  const loading = incomplete && attempt > 0 && !current;
  const control = incomplete ? (
    <output className="block px-3 py-2 text-xs text-muted-foreground">
      {loading
        ? "Loading full result…"
        : (current?.failure ?? "Saved answer unavailable until the full result is loaded.")}
      {!loading && (
        <button type="button" className="ml-2 underline" onClick={() => setAttempt((n) => n + 1)}>
          {current?.failure ? "Retry" : "Load full result"}
        </button>
      )}
    </output>
  ) : null;
  return { result, control };
}
