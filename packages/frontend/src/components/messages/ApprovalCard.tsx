import { useState } from "react";
import { wsService } from "@/services/ws.service";

interface ApprovalCardProps {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  resolved?: "allow" | "deny";
}

export function ApprovalCard({
  sessionId,
  toolUseId,
  toolName,
  toolInput,
  resolved,
}: ApprovalCardProps) {
  const [decision, setDecision] = useState<"allow" | "deny" | null>(resolved ?? null);
  const [denyMode, setDenyMode] = useState(false);
  const [reason, setReason] = useState("");

  const approve = () => {
    if (decision) return;
    setDecision("allow");
    wsService.send({
      type: "approval_response",
      sessionId,
      toolUseId,
      decision: "allow",
    });
  };

  const confirmDeny = () => {
    if (decision) return;
    setDecision("deny");
    wsService.send({
      type: "approval_response",
      sessionId,
      toolUseId,
      decision: "deny",
      reason: reason.trim() || undefined,
    });
  };

  return (
    <div className="px-4 py-2">
      <div className="rounded-lg border border-amber-800/50 bg-amber-950/30">
        <div className="flex items-center gap-2 border-b border-amber-900/50 px-3 py-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
          <span className="text-xs font-medium uppercase tracking-wider text-amber-300">
            Approval needed · {toolName}
          </span>
        </div>
        <pre className="overflow-x-auto border-b border-amber-900/50 px-3 py-2 text-xs text-amber-100">
          {formatValue(toolInput)}
        </pre>
        {decision ? (
          <div className="px-3 py-3 text-center text-xs text-neutral-500">
            {decision === "allow" ? "Approved" : "Denied"}
            {decision === "deny" && reason.trim() && (
              <div className="mt-1 text-neutral-600">"{reason.trim()}"</div>
            )}
          </div>
        ) : denyMode ? (
          <div className="flex flex-col gap-2 p-2">
            <input
              // biome-ignore lint/a11y/noAutofocus: focusing the reason field on deny click is intentional
              autoFocus
              type="text"
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmDeny();
                if (e.key === "Escape") setDenyMode(false);
              }}
              className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none ring-1 ring-amber-900/50 focus:ring-amber-700"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDenyMode(false)}
                className="flex-1 rounded-md bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-300 transition-opacity active:opacity-80"
              >
                Back
              </button>
              <button
                type="button"
                onClick={confirmDeny}
                className="flex-1 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-opacity active:opacity-80"
              >
                Deny
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 p-2">
            <button
              type="button"
              onClick={approve}
              className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-opacity active:opacity-80"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => setDenyMode(true)}
              className="flex-1 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-opacity active:opacity-80"
            >
              Deny…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
