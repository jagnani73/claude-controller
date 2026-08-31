import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { wsService } from "@/services/ws.service";

interface ApprovalCardProps {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  resolved?: "allow" | "deny";
}

type Mode = "idle" | "deny" | "edit";

export function ApprovalCard({
  sessionId,
  toolUseId,
  toolName,
  toolInput,
  resolved,
}: ApprovalCardProps) {
  const [decision, setDecision] = useState<"allow" | "deny" | null>(resolved ?? null);
  const [mode, setMode] = useState<Mode>("idle");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [wasEdited, setWasEdited] = useState(false);

  // Editing sends `updatedInput`, which Claude Code substitutes for the tool's
  // input *wholesale* — so it only makes sense when the input is an object we
  // can round-trip. A string-bodied input has no shape to preserve.
  const canEdit = isPlainObject(toolInput);

  const approve = (updatedInput?: unknown) => {
    if (decision) return;
    setDecision("allow");
    setWasEdited(updatedInput !== undefined);
    wsService.send({
      type: "approval_response",
      sessionId,
      toolUseId,
      decision: "allow",
      ...(updatedInput !== undefined ? { updatedInput } : {}),
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

  const startEdit = () => {
    setDraft(formatValue(toolInput));
    setDraftError(null);
    setMode("edit");
  };

  const confirmEdit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      // Surface the parse error instead of sending it: a malformed payload
      // would be rejected downstream and strand the session on the CLI's own
      // picker, which isn't visible from here.
      setDraftError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }
    if (!isPlainObject(parsed)) {
      setDraftError("Tool input must be a JSON object");
      return;
    }
    approve(parsed);
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

        {mode !== "edit" && (
          <pre className="overflow-x-auto border-b border-accent/20 bg-muted/20 px-3 py-2 font-mono text-[12px] text-foreground/85">
            {formatValue(toolInput)}
          </pre>
        )}

        {decision ? (
          <div className="px-3 py-3 text-center text-sm text-muted-foreground">
            {decision === "allow" ? (wasEdited ? "Approved · edited" : "Approved") : "Denied"}
            {decision === "deny" && reason.trim() && (
              <div className="mt-1 text-muted-foreground/70">"{reason.trim()}"</div>
            )}
          </div>
        ) : mode === "deny" ? (
          <div className="flex flex-col gap-2 p-2">
            <Input
              // Focus the reason field: the user just chose to deny.
              autoFocus
              type="text"
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmDeny();
                if (e.key === "Escape") setMode("idle");
              }}
            />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setMode("idle")}>
                Back
              </Button>
              <Button variant="destructive" className="flex-1" onClick={confirmDeny}>
                Deny
              </Button>
            </div>
          </div>
        ) : mode === "edit" ? (
          <div className="flex flex-col gap-2 p-2">
            <Textarea
              // Focus the editor: entering this mode means intent to edit.
              autoFocus
              className="min-h-40 font-mono text-[12px]"
              spellCheck={false}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (draftError) setDraftError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setMode("idle");
              }}
            />
            {draftError && <div className="px-1 text-xs text-destructive">{draftError}</div>}
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setMode("idle")}>
                Back
              </Button>
              <Button className="flex-1" onClick={confirmEdit}>
                Approve edited
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 p-2">
            <Button onClick={() => approve()} className="flex-1">
              Approve
            </Button>
            {canEdit && (
              <Button variant="ghost" className="flex-1" onClick={startEdit}>
                Edit…
              </Button>
            )}
            <Button
              variant="ghost"
              className="flex-1 text-muted-foreground hover:text-destructive"
              onClick={() => setMode("deny")}
            >
              Deny…
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
