import type { ToolResult } from "common/types";
import { HelpCircle, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWsState } from "@/hooks/use-ws";
import { cn } from "@/lib/utils";
import { wsService } from "@/services/ws.service";
import { answerIncludesLabel, extractAnswer } from "./question-result";

interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

interface QuestionCardProps {
  sessionId: string;
  toolUseId: string;
  input: unknown;
  result?: ToolResult | null;
}

interface PerQuestionState {
  selectedLabels: string[];
  /** Free text typed into the "Type something" slot (non-preview questions). */
  customText: string;
  /** A note attached to the selected option (preview questions only). Coexists
   *  with the selection rather than replacing it; maps to `annotations.notes`. */
  notes: string;
}

const blankState = (): PerQuestionState => ({ selectedLabels: [], customText: "", notes: "" });

export function QuestionCard({ sessionId, toolUseId, input, result }: QuestionCardProps) {
  const questions = useMemo(() => extractQuestions(input), [input]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [state, setState] = useState<Record<number, PerQuestionState>>(() => {
    // Single-select questions get the first option pre-selected so users
    // never see a "nothing focused" state. Multi-select stays empty by default.
    const initial: Record<number, PerQuestionState> = {};
    questions.forEach((q, qi) => {
      initial[qi] =
        !q.multiSelect && q.options.length > 0
          ? { selectedLabels: [q.options[0].label], customText: "", notes: "" }
          : blankState();
    });
    return initial;
  });
  const [submitted, setSubmitted] = useState(false);
  // Gate submit/cancel on a live socket: question_response is a one-shot,
  // time-sensitive action, so we don't want to optimistically lock the card and
  // queue an answer that fires (stale) on a later reconnect.
  const connected = useWsState() === "connected";

  const get = (qi: number): PerQuestionState => state[qi] ?? blankState();
  const update = (qi: number, patch: Partial<PerQuestionState>): void => {
    setState((s) => ({ ...s, [qi]: { ...get(qi), ...patch } }));
  };

  const toggleLabel = (qi: number, label: string, multi: boolean): void => {
    const cur = get(qi);
    if (multi) {
      // Multi-select: toggle this label; leave customText alone so the user
      // can mix checkboxes with a free-text answer (matches CLI behavior).
      const has = cur.selectedLabels.includes(label);
      update(qi, {
        selectedLabels: has
          ? cur.selectedLabels.filter((l) => l !== label)
          : [...cur.selectedLabels, label],
      });
    } else {
      // Single-select XOR: picking an option clears any custom text.
      update(qi, { selectedLabels: [label], customText: "" });
    }
  };

  const setCustomText = (qi: number, value: string): void => {
    const cur = get(qi);
    // Single-select XOR: typing wipes the selected label so the submitted
    // answer is unambiguous. Multi-select keeps both — checkboxes and free
    // text coexist there.
    const isMulti = questions[qi]?.multiSelect ?? false;
    if (isMulti) {
      update(qi, { customText: value });
    } else {
      update(qi, { customText: value, selectedLabels: value ? [] : cur.selectedLabels });
    }
  };

  // A note annotates the selected option, so it never clears the selection
  // (unlike custom text). Only used on preview questions.
  const setNotes = (qi: number, value: string): void => {
    update(qi, { notes: value });
  };

  const hasAnswerFor = (qi: number): boolean => {
    const s = get(qi);
    return s.selectedLabels.length > 0 || s.customText.trim().length > 0;
  };

  const allAnswered = questions.every((_q, qi) => hasAnswerFor(qi));

  const submit = (): void => {
    if (submitted || !allAnswered || !connected) return;
    setSubmitted(true);
    wsService.send({
      type: "question_response",
      sessionId,
      toolUseId,
      questions: questions.map((q) => ({
        multiSelect: q.multiSelect,
        optionLabels: q.options.map((o) => o.label),
        // Gates the backend's notes (`n`) keystroke path — notes only exist on
        // the preview view (single-select whose options carry previews).
        hasPreview: !q.multiSelect && q.options.some((o) => o.preview),
      })),
      answers: questions.map((_q, qi) => {
        const s = get(qi);
        return {
          selectedLabels: s.selectedLabels.length ? s.selectedLabels : undefined,
          customText: s.customText.trim() ? s.customText.trim() : undefined,
          notes: s.notes.trim() ? s.notes.trim() : undefined,
        };
      }),
    });
  };

  const cancel = (): void => {
    if (submitted || !connected) return;
    setSubmitted(true);
    wsService.send({ type: "question_response", sessionId, toolUseId, cancel: true });
  };

  const isLocked = submitted || !!result;

  if (questions.length === 0) {
    return (
      <div className="px-4 py-2">
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card/60 p-3">
          <pre className="overflow-x-auto font-mono text-[12px] text-foreground/85">
            {formatValue(input)}
          </pre>
        </div>
      </div>
    );
  }

  const q = questions[activeIdx];
  const s = get(activeIdx);
  // Per-question selection lives in local component state, which is lost on a
  // page reload — but the tool result carries the answer in prose. Recover it
  // so a reloaded "answered" card shows what was chosen instead of "No answer
  // recorded". Local state wins while live; the result is the fallback.
  const lockedAnswerText = isLocked && result ? extractAnswer(result.value, q.question) : null;
  const recoveredLabels = lockedAnswerText
    ? q.options.filter((o) => answerIncludesLabel(lockedAnswerText, o.label)).map((o) => o.label)
    : [];
  // When the card is locked by an external answer (terminal / another device /
  // post-reload) rather than our own submit, the local selection is just the
  // pre-selected first-option default (single-select pre-selects options[0]) and
  // would show the wrong "You picked". Prefer the answer recovered from the
  // result. When WE submitted, trust the live local selection.
  const answeredElsewhere = !!result && !submitted;
  const effectiveSelectedLabels =
    answeredElsewhere && lockedAnswerText
      ? recoveredLabels
      : s.selectedLabels.length > 0
        ? s.selectedLabels
        : recoveredLabels;
  const hasPreview = !q.multiSelect && q.options.some((o) => o.preview);
  const focusedOption =
    q.options.find((o) => o.label === effectiveSelectedLabels[0]) ?? q.options[0];
  // Single-select XOR: typing a custom answer locks out the options. In
  // multi-select, options stay tappable alongside any custom text.
  const optionsDisabled = isLocked || (!q.multiSelect && s.customText.length > 0);

  return (
    <div className="px-4 py-2">
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/60">
        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
          <HelpCircle className="size-3.5 text-accent" strokeWidth={2} />
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Question
          </span>
          {isLocked && (
            <span className="ml-auto text-xs text-muted-foreground/70">
              {result?.isError ? "error" : "answered"}
            </span>
          )}
        </div>

        {questions.length > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-border/30 px-2 py-1.5">
            {questions.map((qq, qi) => {
              // Stay clickable after lock so answers can be reviewed per tab.
              // A successful result means every question was answered, even
              // after a reload wiped the local per-question state.
              const answered = hasAnswerFor(qi) || (!!result && !result.isError);
              return (
                <button
                  type="button"
                  key={qq.question}
                  onClick={() => setActiveIdx(qi)}
                  className={cn(
                    "shrink-0 rounded-md px-2 py-1 font-mono text-xs",
                    qi === activeIdx
                      ? "bg-accent/20 text-accent"
                      : "text-muted-foreground hover:text-foreground",
                    answered && qi !== activeIdx && "text-foreground/80",
                  )}
                >
                  {answered ? "☒" : "☐"} {qq.header}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-3 p-3">
          <div className="font-serif text-base text-foreground">{q.question}</div>

          {isLocked && (
            <div className="rounded-md border border-accent/30 bg-accent/[0.06] px-3 py-2 text-sm">
              {s.customText.trim() ? (
                <>
                  <span className="mr-2 text-xs uppercase tracking-wider text-muted-foreground">
                    You typed
                  </span>
                  <span className="text-foreground">{s.customText.trim()}</span>
                </>
              ) : effectiveSelectedLabels.length > 0 ? (
                <>
                  <span className="mr-2 text-xs uppercase tracking-wider text-muted-foreground">
                    You picked
                  </span>
                  <span className="text-foreground">{effectiveSelectedLabels.join(", ")}</span>
                </>
              ) : lockedAnswerText ? (
                // Recovered from the result but matches no option — a custom
                // ("Other") answer typed before the reload.
                <>
                  <span className="mr-2 text-xs uppercase tracking-wider text-muted-foreground">
                    You answered
                  </span>
                  <span className="text-foreground">{lockedAnswerText}</span>
                </>
              ) : (
                <span className="text-muted-foreground italic">No answer recorded</span>
              )}
              {s.notes.trim() && (
                <div className="mt-1.5 border-t border-border/30 pt-1.5">
                  <span className="mr-2 text-xs uppercase tracking-wider text-muted-foreground">
                    Note
                  </span>
                  <span className="text-foreground">{s.notes.trim()}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            {q.options.map((opt) => {
              const selected = effectiveSelectedLabels.includes(opt.label);
              return (
                <button
                  type="button"
                  key={opt.label}
                  onClick={() => toggleLabel(activeIdx, opt.label, q.multiSelect)}
                  disabled={optionsDisabled}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                    selected
                      ? "border-accent/60 bg-accent/[0.08]"
                      : "border-border/40 bg-card/30 hover:bg-card/60",
                    optionsDisabled && "opacity-50",
                  )}
                >
                  <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {q.multiSelect ? (selected ? "[✓]" : "[ ]") : selected ? "●" : "○"}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm text-foreground">{opt.label}</span>
                    {opt.description && (
                      <span className="text-xs text-muted-foreground/85">{opt.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Show the focused option's preview while choosing, and keep the
              selected option's preview visible after answering. Suppressed when
              the answer came from custom text (no option picked). */}
          {hasPreview &&
            focusedOption?.preview &&
            (!isLocked || effectiveSelectedLabels.length > 0) && (
              <pre className="overflow-x-auto rounded-md border border-border/30 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-snug text-foreground/85">
                {focusedOption.preview}
              </pre>
            )}

          {!isLocked && (
            <div className="relative">
              {/* Preview questions: the input is a NOTE on the selected option
                  (coexists, → annotations.notes). Everything else: free-text that
                  REPLACES the option choice ("Type something" / Other). */}
              <Input
                type="text"
                placeholder={hasPreview ? "Add a note…" : "Type something…"}
                value={hasPreview ? s.notes : s.customText}
                onChange={(e) =>
                  hasPreview
                    ? setNotes(activeIdx, e.target.value)
                    : setCustomText(activeIdx, e.target.value)
                }
                className={(hasPreview ? s.notes : s.customText) ? "pr-9" : undefined}
              />
              {(hasPreview ? s.notes : s.customText) && (
                <button
                  type="button"
                  onClick={() =>
                    hasPreview ? setNotes(activeIdx, "") : setCustomText(activeIdx, "")
                  }
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label={hasPreview ? "Clear note" : "Clear typed answer"}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          )}

          {!isLocked && (
            <div className="flex gap-2">
              {/* Batched calls: advance through tabs with "Next" and only show
                  "Submit" on the last question — a single disabled "Submit"
                  while early questions are unanswered reads as a dead end. */}
              {activeIdx < questions.length - 1 ? (
                <Button className="flex-1" onClick={() => setActiveIdx(activeIdx + 1)}>
                  Next
                </Button>
              ) : (
                <Button
                  className="flex-1"
                  onClick={submit}
                  disabled={!allAnswered || !connected}
                  title={
                    !connected
                      ? "Reconnecting…"
                      : allAnswered
                        ? undefined
                        : "Answer all questions first"
                  }
                >
                  Submit
                </Button>
              )}
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={cancel}
                disabled={!connected}
                title={connected ? undefined : "Reconnecting…"}
                aria-label="Cancel"
              >
                <X className="size-4" />
              </Button>
            </div>
          )}

          {result && (
            <details>
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
      </div>
    </div>
  );
}

function extractQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((q) => {
      if (!q || typeof q !== "object") return null;
      const obj = q as Record<string, unknown>;
      const question = typeof obj.question === "string" ? obj.question : "";
      const header = typeof obj.header === "string" ? obj.header : "";
      const multiSelect = obj.multiSelect === true;
      const rawOptions = Array.isArray(obj.options) ? obj.options : [];
      const options: AskOption[] = [];
      for (const o of rawOptions) {
        if (!o || typeof o !== "object") continue;
        const oo = o as Record<string, unknown>;
        const label = typeof oo.label === "string" ? oo.label : "";
        if (!label) continue;
        const opt: AskOption = { label };
        if (typeof oo.description === "string") opt.description = oo.description;
        if (typeof oo.preview === "string") opt.preview = oo.preview;
        options.push(opt);
      }
      if (!question || options.length === 0) return null;
      return { question, header, multiSelect, options };
    })
    .filter((q): q is AskQuestion => q !== null);
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
