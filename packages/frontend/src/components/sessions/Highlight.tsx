/**
 * Highlights the first occurrence of `query` inside `text`, matching
 * case-insensitively and ignoring hyphens, underscores, and whitespace.
 *
 * The match range is computed on a normalized version of both strings, then
 * mapped back to indices in the ORIGINAL `text` so the highlighted span
 * preserves the text's formatting.
 */
interface HighlightProps {
  text: string;
  query: string;
}

export function Highlight({ text, query }: HighlightProps) {
  const range = findMatchRange(text, query);
  if (!range) return <>{text}</>;
  const [start, end] = range;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-[3px] bg-amber-400/25 px-[1px] text-amber-100">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

export function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]+/g, "");
}

function findMatchRange(text: string, query: string): [number, number] | null {
  const normQuery = normalizeSearch(query);
  if (!normQuery) return null;

  // Build a parallel array: for each kept char in the normalized version,
  // remember its index in the original string.
  const kept: string[] = [];
  const originalIdx: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "-" || c === "_" || /\s/.test(c)) continue;
    kept.push(c.toLowerCase());
    originalIdx.push(i);
  }
  const normText = kept.join("");
  const pos = normText.indexOf(normQuery);
  if (pos === -1) return null;

  const startOrig = originalIdx[pos];
  const endOrig = originalIdx[pos + normQuery.length - 1] + 1;
  return [startOrig, endOrig];
}
