import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      <div className="overflow-hidden rounded-xl border border-accent/40 bg-accent/[0.04]">
        <div className="flex items-center gap-2 border-b border-accent/30 px-3 py-2">
          <ShieldCheck className="size-3.5 text-accent" strokeWidth={2} />
          <span className="font-mono text-xs uppercase tracking-wider text-accent">
            Approval needed
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="font-mono text-xs text-foreground/80">{toolName}</span>
        </div>
        <pre className="overflow-x-auto border-b border-accent/20 bg-muted/20 px-3 py-2 font-mono text-[12px] text-foreground/85">
          {formatValue(toolInput)}
        </pre>
        {decision ? (
          <div className="px-3 py-3 text-center text-sm text-muted-foreground">
            {decision === "allow" ? "Approved" : "Denied"}
            {decision === "deny" && reason.trim() && (
              <div className="mt-1 text-muted-foreground/70">"{reason.trim()}"</div>
            )}
          </div>
        ) : denyMode ? (
          <div className="flex flex-col gap-2 p-2">
            <Input
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
            />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setDenyMode(false)}>
                Back
              </Button>
              <Button variant="destructive" className="flex-1" onClick={confirmDeny}>
                Deny
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 p-2">
            <Button onClick={approve} className="flex-1">
              Approve
            </Button>
            <Button
              variant="ghost"
              className="flex-1 text-muted-foreground hover:text-destructive"
              onClick={() => setDenyMode(true)}
            >
              Deny…
            </Button>
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
