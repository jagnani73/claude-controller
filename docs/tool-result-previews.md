# On-demand tool results

Tool results are projected only at the WebSocket boundary. The transcript and SessionBus retain the original values and error flags; relay/reconciliation never consume previews. Live, replay and history all use the same projection, cached weakly by event so retention can reclaim it.

Results with JSON-encoded UTF-8 values over **4096 bytes** carry an explicit `preview` (`truncated: true`, `format: text | json`, `totalBytes`). The preview is a string, not a pretend partially parsed object. The encoded preview value is at most 4096 bytes, including escaping. Small values keep their exact shape. Approval failures are classified on the full error before truncation; a bounded 1024-character reason is sent separately, so a late hook-failure marker cannot be lost. The full error remains accessible through expansion.

Expanding a result requests `fetch_tool_result` with session/agent-stream id, tool-use id and request id. `tool_result_full` returns the original value and isError, or explicit `unavailable`. The lookup only searches that registered bus's retained log: no filesystem path is accepted and no transcript is modified. An evicted session, closed agent stream or trimmed event is unavailable; this version deliberately does not reopen transcripts. Exact full access is therefore guaranteed only while retained, never implied for a preview.

The client coalesces concurrent requests, resends pending reads on a new connected socket, times out after 30 seconds and offers explicit retry. A successful value stays in its mounted card across collapse/reopen; it is released on unmount (remount can fetch again). Closing a row unmounts its body. Large input and result values are formatted only when open. Full responses are intentionally not size-capped: an explicit expansion may still transfer/mount a very large value.

## Measurement

Temporary script, Node/React SSR, 20 iterations on this Windows worktree: 20,000 object rows with repeated output text. Baseline reproduces eager pretty-printing and two mounted details/pre bodies; after uses the actual ToolCallCard. This is not a browser layout measurement.

| Metric | Before | After |
| --- | ---: | ---: |
| Result message bytes | 4,508,998 | 3,955 |
| Collapsed render ms | 38.63 | 0.41 |
| Rendered HTML bytes | 11,257,960 | 1,519 |
| Mounted pre bodies | 2 | 0 |

A 4 KiB preview keeps a useful prefix while removing 99.91% of this representative payload. Escaped newline/emoji stress input produced a 3,806-byte preview value. A hook-failure marker after 10,000 prefix characters was correctly classified from the original result. The temporary benchmark was removed, not added to the test suite.
