/**
 * When the workflow poller may actually write a request.
 *
 * Split out of the hook so the two rules the backend imposes can be stated — and
 * tested — without React: it serves **one snapshot per socket at a time**
 * (`busy` drops a second request) and **refuses anything inside
 * `WORKFLOW_REQUEST_MIN_MS`**, both times *silently*. A request sent regardless
 * is therefore not merely wasteful: its answer never comes, and the panel sits on
 * a stale list with no error to explain it.
 */

/** Minimum gap the backend allows between two snapshots on one socket. */
export const MIN_REQUEST_SPACING_MS = 750;

export type RequestAction =
  /** A request is already in flight; nothing is applied but its answer. */
  | { kind: "hold" }
  /** Inside the backend's gap: ask again after `ms`, never now. */
  | { kind: "defer"; ms: number }
  /** Write the request. */
  | { kind: "send" };

export function nextRequestAction(input: {
  hasPending: boolean;
  lastSentAt: number;
  now: number;
}): RequestAction {
  if (input.hasPending) return { kind: "hold" };
  const wait = input.lastSentAt + MIN_REQUEST_SPACING_MS - input.now;
  return wait > 0 ? { kind: "defer", ms: wait } : { kind: "send" };
}
