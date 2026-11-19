import type { IntegrationCatalogResponse } from "common/integration-types";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useWsState } from "@/hooks/use-ws";
import { wsService } from "@/services/ws.service";

export function IntegrationsPanel({
  sessionId,
  onOpenChange,
}: {
  sessionId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const connection = useWsState();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<IntegrationCatalogResponse>();
  const [error, setError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly triggers a refresh.
  useEffect(() => {
    setResult(undefined);
    setError(undefined);
    if (connection !== "connected") {
      setError("Disconnected. Retry after reconnecting.");
      return;
    }
    const generation = wsService.socketGeneration;
    let active = true;
    let requestId: string | undefined;
    let attached = false;
    let waitingForAttachment = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      active = false;
      setError("Setup inventory timed out. Retry.");
    }, 15000);
    const request = () => {
      if (!active || requestId || generation !== wsService.socketGeneration) return;
      if (wsService.state !== "connected") return;
      const id = crypto.randomUUID();
      requestId = id;
      if (
        !wsService.sendImmediate({ type: "integration_catalog_request", sessionId, requestId: id })
      ) {
        requestId = undefined;
        active = false;
        clearTimeout(timer);
        setError("Setup inventory could not be sent. Retry.");
      }
    };
    const retryAfterAttachment = () => {
      waitingForAttachment = false;
      attached = false;
      // Allow the server's per-socket request throttle to clear.
      retryTimer = setTimeout(request, 600);
    };
    const ready = wsService.on("history_available", (message) => {
      if (!active || message.type !== "history_available" || message.sessionId !== sessionId)
        return;
      attached = true;
      if (waitingForAttachment && !requestId) retryAfterAttachment();
    });
    const unsubscribe = wsService.on("integration_catalog", (message) => {
      if (
        message.type !== "integration_catalog" ||
        !active ||
        message.sessionId !== sessionId ||
        message.requestId !== requestId ||
        generation !== wsService.socketGeneration
      )
        return;
      requestId = undefined;
      if (message.error === "Subscribe to a live session first.") {
        waitingForAttachment = true;
        if (attached) retryAfterAttachment();
        return;
      }
      active = false;
      clearTimeout(timer);
      if (message.error) setError(message.error);
      else setResult(message);
    });
    request();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      ready();
      unsubscribe();
    };
  }, [sessionId, connection, attempt]);
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        animated={false}
        side="right"
        className="h-dvh max-h-dvh w-full min-w-0 gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-xl"
      >
        <SheetHeader className="shrink-0 px-4 py-4 pr-12">
          <SheetTitle>Inspect setup</SheetTitle>
          <SheetDescription>Read-only MCP configuration inventory</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 overflow-y-auto border-t p-4 text-sm">
          <h2 className="font-semibold">MCP servers</h2>
          <p className="mt-2 text-muted-foreground">
            Configured; live tools and status not inspected. Enablement, approval, authentication
            and managed policy are unknown. No servers are started by this view.
          </p>
          <div className="my-4">
            <Button
              variant="outline"
              size="sm"
              disabled={!error && !result}
              onClick={() => setAttempt((n) => n + 1)}
            >
              Refresh
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {!error && !result && <p>Reading configuration…</p>}
          {result && (
            <>
              <ul className="space-y-2">
                {result.entries.map((entry, index) => (
                  <li key={`${entry.scope}-${index}`} className="min-w-0 rounded-md border p-3">
                    <div className="break-all font-medium" dir="auto">
                      {entry.name}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {entry.scope} · {entry.transport} · enablement unknown
                    </div>
                  </li>
                ))}
              </ul>
              {result.entries.length === 0 && <p>No servers found in the readable sources.</p>}
              {result.truncated && (
                <p className="mt-3 text-warning">
                  Inventory is incomplete or some names were skipped.
                </p>
              )}
              <h3 className="mt-5 font-medium">Sources</h3>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {result.sources.map((source) => (
                  <li key={source.scope}>
                    {source.scope === "user-local"
                      ? "User and local configuration"
                      : "Project configuration"}
                    : {source.status}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-muted-foreground">
                Only the session directory is inspected, not ancestor projects or plugins. Entries
                are not merged into an effective configuration.
              </p>
            </>
          )}
          <p className="mt-5 text-muted-foreground">
            For live status or authorization, use <code>/mcp</code> in the local Claude Code
            terminal. This panel does not open sign-in or change configuration.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
