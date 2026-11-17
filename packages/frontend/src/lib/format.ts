/**
 * Compact token counts: 131619 -> "132K".
 *
 * Shared so a context figure reads the same wherever it appears (the session top
 * bar's in/out tokens and a workflow agent's context). Purely presentational —
 * callers decide whether a missing value shows anything at all, so `undefined`
 * is never coerced to 0 here.
 */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
