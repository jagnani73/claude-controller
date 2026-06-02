import { cycleCanIncludeAuto } from "common/permission-cycle";
import type { ClaudeModel, PlanDecision, ToolResult } from "common/types";
import { ClipboardCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWsState } from "@/hooks/use-ws";
import { cn } from "@/lib/utils";
import { wsService } from "@/services/ws.service";
import { Markdown } from "./Markdown";

interface PlanCardProps {
  sessionId: string;
  toolUseId: string;
  input: unknown;
  result?: ToolResult | null;
  /** The session's running model — predicts whether picker position 1 is
   *  "use auto mode" (auto-capable) or "auto-accept edits". Cosmetic only (the
   *  backend computes the actual resulting mode); falls back to the non-auto
   *  label when unknown. */
  model?: ClaudeModel;
}

type PlanAction = PlanDecision | "cancel";

/**
 * Renders an `ExitPlanMode` plan approval as tappable buttons that drive the
 * CLI's ink picker over the PTY (via a `plan_response` WS message). Picker
 * positions are stable at normal context: position 1 = the elevated keep-context
 * approve (auto mode when supported, else auto-accept edits), position 2 =
 * manually approve → default. We never touch the shifting later positions
 * (Ultraplan / feedback); "Keep planning" sends Esc (cancel). See
 * `plan.input.ts` for the high-context limitation.
 */
export function PlanCard({ sessionId, toolUseId, input, result, model }: PlanCardProps) {
  const plan = useMemo(() => extractPlan(input), [input]);
  const [submitted, setSubmitted] = useState<PlanAction | null>(null);
  // Gate on a live socket: plan_response is a one-shot action — don't lock the
  // card and queue a response that fires (stale) on a later reconnect.
  const connected = useWsState() === "connected";

  const isLocked = submitted !== null || !!result;
  // What picker position 1 means for this model (best-effort, see plan.input.ts).
  const primaryLabel = model && cycleCanIncludeAuto(model) ? "auto mode" : "auto-accept edits";

  const respond = (decision: PlanDecision): void => {
    if (isLocked || !connected) return;
    setSubmitted(decision);
    wsService.send({ type: "plan_response", sessionId, toolUseId, decision });
  };

  const keepPlanning = (): void => {
    if (isLocked || !connected) return;
    setSubmitted("cancel");
    // `decision` is ignored when `cancel` is set (backend sends Esc), but the
    // message shape requires it.
    wsService.send({
      type: "plan_response",
      sessionId,
      toolUseId,
      decision: "approve-primary",
      cancel: true,
    });
  };

  const lockedLabel =
    submitted === "approve-primary"
      ? `Approved · ${primaryLabel}`
      : submitted === "approve-manual"
        ? "Approved · manual approvals"
        : submitted === "cancel"
          ? "Kept planning"
          : result?.isError
            ? "Couldn't deliver"
            : "Responded";

  return (
    <div className="px-4 py-2">
      <div className="overflow-hidden rounded-xl border border-accent/40 bg-accent/[0.04]">
        <div className="flex items-center gap-2 border-b border-accent/30 px-3 py-2">
          <ClipboardCheck className="size-3.5 text-accent" strokeWidth={2} />
          <span className="font-mono text-xs uppercase tracking-wider text-accent">Plan ready</span>
          {isLocked && (
            <span className="ml-auto text-xs text-muted-foreground/70">
              {result?.isError ? "error" : submitted ? "sent" : "answered"}
            </span>
          )}
        </div>

        {plan ? (
          <div className="max-h-[40vh] overflow-y-auto border-b border-accent/20 px-3 py-2">
            <Markdown text={plan} />
          </div>
        ) : (
          <pre className="overflow-x-auto border-b border-accent/20 bg-muted/20 px-3 py-2 font-mono text-[12px] text-foreground/85">
            {formatValue(input)}
          </pre>
        )}

        {isLocked ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">
            {lockedLabel}
            {result && (
              <details className="mt-2">
                <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
                  Show result
                </summary>
                <pre
                  className={cn(
                    "mt-2 overflow-x-auto rounded-md bg-muted/30 px-3 py-2 font-mono text-[12px]",
                    result.isError ? "text-destructive" : "text-foreground/85",
                  )}
                >
                  {formatValue(result.value)}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-2">
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => respond("approve-primary")}
                disabled={!connected}
                title={connected ? undefined : "Reconnecting…"}
              >
                Approve · {primaryLabel}
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => respond("approve-manual")}
                disabled={!connected}
                title={connected ? undefined : "Reconnecting…"}
              >
                Approve · manual
              </Button>
            </div>
            <Button
              variant="ghost"
              className="text-muted-foreground"
              onClick={keepPlanning}
              disabled={!connected}
            >
              Keep planning
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function extractPlan(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const plan = (input as { plan?: unknown }).plan;
  return typeof plan === "string" && plan.trim() ? plan : null;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
