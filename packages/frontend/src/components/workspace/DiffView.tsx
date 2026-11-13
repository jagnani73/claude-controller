import type { DiffLine, WorkspaceResult } from "common/types";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

type Diff = Extract<WorkspaceResult, { kind: "diff" }>;
type Row = { left?: DiffLine; right?: DiffLine; id: string };
function splitRows(lines: DiffLine[]): Row[] {
  const rows: Row[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({
        left: removed[i],
        right: added[i],
        id: `c${removed[i]?.oldLine ?? ""}:${added[i]?.newLine ?? ""}`,
      });
    }
    removed = [];
    added = [];
  }
  for (const line of lines) {
    if (line.kind === "context") {
      flush();
      rows.push({ left: line, right: line, id: `=${line.oldLine}` });
    } else if (line.kind === "remove") removed.push(line);
    else added.push(line);
  }
  flush();
  return rows;
}
const tone = (line?: DiffLine) =>
  line?.kind === "add" ? "bg-success/10" : line?.kind === "remove" ? "bg-destructive/10" : "";

export function DiffView({ diff }: { diff: Diff }) {
  const mobile = useIsMobile();
  const [unified, setUnified] = useState(false);
  const [context, setContext] = useState(false);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => splitRows(diff.lines), [diff.lines]);
  const visible = context
    ? diff.lines
    : diff.lines.filter(
        (line, i, all) =>
          line.kind !== "context" ||
          all.slice(Math.max(0, i - 3), i + 4).some((near) => near.kind !== "context"),
      );
  const splitVisible = context
    ? rows
    : rows.filter(
        (row, i, all) =>
          row.left?.kind !== "context" ||
          all.slice(Math.max(0, i - 3), i + 4).some((near) => near.left?.kind !== "context"),
      );
  const split = !mobile && !unified;
  const total = split ? splitVisible.length : visible.length;
  const start = Math.min(page * 300, Math.max(0, Math.floor((total - 1) / 300) * 300));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1 text-xs text-muted-foreground">
        <span className="mr-auto">
          {diff.oldLabel} → {diff.newLabel} · read-only
        </span>
        {!mobile && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={unified}
            onClick={() => {
              setUnified(!unified);
              setPage(0);
            }}
          >
            {unified ? "Side-by-side" : "Unified"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={context}
          onClick={() => {
            setContext(!context);
            setPage(0);
          }}
        >
          {context ? "Less context" : "Full context"}
        </Button>
      </div>
      {diff.notice && (
        <output className="border-b border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {diff.notice}
        </output>
      )}
      <section
        className="min-h-0 flex-1 overflow-auto"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the diff horizontally
        tabIndex={0}
        aria-label={split ? "Side-by-side diff" : "Unified diff"}
      >
        {split ? (
          <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="p-2 text-left">{diff.oldLabel}</th>
                <th className="p-2 text-left">{diff.newLabel}</th>
              </tr>
            </thead>
            <tbody>
              {splitVisible.slice(start, start + 300).map((row) => (
                <tr key={row.id}>
                  <td className={cn("border-r border-border/60 align-top", tone(row.left))}>
                    <Cell line={row.left} side="old" />
                  </td>
                  <td className={cn("align-top", tone(row.right))}>
                    <Cell line={row.right} side="new" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {visible.slice(start, start + 300).map((line) => (
                <tr
                  key={`${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}`}
                  className={tone(line)}
                >
                  <td className="w-10 select-none px-2 text-right align-top text-muted-foreground/60">
                    {line.oldLine}
                  </td>
                  <td className="w-10 select-none px-2 text-right align-top text-muted-foreground/60">
                    {line.newLine}
                  </td>
                  <td className="w-5 select-none align-top">
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
                  </td>
                  <td className="whitespace-pre px-2 align-top">{line.text || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {total > 300 && (
        <div className="flex items-center justify-between border-t border-border/60 px-3 py-1 text-xs">
          <Button
            size="sm"
            variant="ghost"
            disabled={start === 0}
            onClick={() => setPage(Math.max(0, page - 1))}
          >
            Previous
          </Button>
          <span>
            Rows {start + 1}–{Math.min(start + 300, total)} of {total}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={start + 300 >= total}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}

function Cell({ line, side }: { line?: DiffLine; side: "old" | "new" }) {
  return (
    <div className="flex min-h-5">
      <span className="w-12 shrink-0 select-none px-2 text-right text-muted-foreground/60">
        {side === "old" ? line?.oldLine : line?.newLine}
      </span>
      <span className="w-4 shrink-0 select-none">
        {line?.kind === "add" ? "+" : line?.kind === "remove" ? "−" : " "}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-all px-2">{line?.text || " "}</span>
    </div>
  );
}
