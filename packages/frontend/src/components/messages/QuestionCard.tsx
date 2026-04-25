import { HelpCircle } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";

interface AskQuestion {
  question?: string;
  options?: Array<string | { label?: string; value?: string }>;
  multiSelect?: boolean;
  allowNotes?: boolean;
}

interface QuestionCardProps {
  toolUseId: string;
  input: unknown;
  result?: { value: unknown; isError: boolean } | null;
}

export function QuestionCard({ input, result }: QuestionCardProps) {
  const questions = extractQuestions(input);

  return (
    <div className="px-4 py-2">
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/60">
        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
          <HelpCircle className="size-3.5 text-accent" strokeWidth={2} />
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Question
          </span>
          {result && (
            <span className="ml-auto text-xs text-muted-foreground/70">
              {result.isError ? "error" : "answered"}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-3 p-3">
          {questions.length === 0 ? (
            <pre className="overflow-x-auto font-mono text-[12px] text-foreground/85">
              {formatValue(input)}
            </pre>
          ) : (
            questions.map((q, qi) => (
              <div
                key={`q-${
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable, small list
                  qi
                }`}
                className="flex flex-col gap-2"
              >
                {q.question && (
                  <div className="font-serif text-base text-foreground">{q.question}</div>
                )}
                {q.options && q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((opt, oi) => {
                      const label = typeof opt === "string" ? opt : (opt.label ?? opt.value ?? "");
                      return (
                        <Pill
                          key={`${qi}-${
                            // biome-ignore lint/suspicious/noArrayIndexKey: stable, small list
                            oi
                          }`}
                          disabled
                        >
                          {label}
                        </Pill>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-3 text-xs text-muted-foreground/60">
                  {q.multiSelect && <span>multi-select</span>}
                  {q.allowNotes && <span>notes allowed</span>}
                </div>
              </div>
            ))
          )}
          {!result && (
            <div className="rounded-md border border-border/40 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Type your answer in the input bar below.
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
  const obj = input as Record<string, unknown>;

  if (Array.isArray(obj.questions)) {
    return obj.questions.filter((q): q is AskQuestion => typeof q === "object" && q !== null);
  }
  if (typeof obj.question === "string") {
    return [obj as AskQuestion];
  }
  return [];
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
