/**
 * Rendered when Claude uses the `AskUserQuestion` tool. The question + options
 * come in via the tool_use block's `input`. For now we just render the
 * question nicely — user answers via the InputBar because Claude Code's
 * internal selection UI consumes arrow-key/space/enter events from stdin,
 * and replying from outside that event loop would take a separate dance.
 *
 * Once this is observed end-to-end, we'll wire tappable options that
 * actually submit the selection via stdin keystrokes.
 */

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
      <div className="rounded-lg border border-sky-800/50 bg-sky-950/30">
        <div className="flex items-center gap-2 border-b border-sky-900/50 px-3 py-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
          <span className="text-xs font-medium uppercase tracking-wider text-sky-300">
            Claude is asking · AskUserQuestion
          </span>
          {result && (
            <span className="ml-auto text-xs text-neutral-500">
              {result.isError ? "error" : "answered"}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-3 p-3">
          {questions.length === 0 ? (
            <pre className="overflow-x-auto text-xs text-sky-100">{formatValue(input)}</pre>
          ) : (
            questions.map((q, qi) => (
              <div
                key={`q-${
                  // biome-ignore lint/suspicious/noArrayIndexKey: question list is small and stable
                  qi
                }`}
                className="flex flex-col gap-2"
              >
                {q.question && <div className="text-sm font-medium text-sky-100">{q.question}</div>}
                {q.options && q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((opt, oi) => {
                      const label = typeof opt === "string" ? opt : (opt.label ?? opt.value ?? "");
                      return (
                        <span
                          key={`${qi}-${
                            // biome-ignore lint/suspicious/noArrayIndexKey: option list is small and stable
                            oi
                          }`}
                          className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 ring-1 ring-sky-900/40"
                        >
                          {label}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-3 text-xs text-neutral-500">
                  {q.multiSelect && <span>multi-select</span>}
                  {q.allowNotes && <span>notes allowed</span>}
                </div>
              </div>
            ))
          )}
          {!result && (
            <div className="mt-1 rounded-md bg-sky-950/60 px-3 py-2 text-xs text-sky-200">
              Type your answer in the input bar.
            </div>
          )}
          {result && (
            <details>
              <summary className="cursor-pointer list-none text-xs text-neutral-500 hover:text-neutral-300">
                Show result
              </summary>
              <pre
                className={`mt-2 overflow-x-auto rounded-md bg-neutral-900 px-3 py-2 text-xs ${
                  result.isError ? "text-red-400" : "text-neutral-300"
                }`}
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
