# Session transition probe

## Scope and evidence

The installed Claude Code reported **2.1.328**. The existing relay verification target remains 2.1.322; this probe does not re-verify or change it. The CLI's `--help` and the [command reference](https://code.claude.com/docs/en/commands) were consulted first. The reference documents `/clear` (aliases `/reset`, `/new`), `/resume`, `/branch`, and `/cd`; documentation is not evidence that a particular installed transition succeeded.

A disposable interactive `node-pty` session used an explicitly supplied fresh UUID, Haiku with low effort, no built-in tools, and a temporary command `SessionStart` and `UserPromptSubmit` hook. Hook fields, the PID session file, and the main JSONL transcript were checked; terminal output was used only to recognize the blocking dialog. One harmless prompt returned successfully. At startup the hook, PID file, and subsequent transcript identified the original session and original cwd. Its transcript did not exist at the initial hook but existed after the prompt. Confidence: high for those initial observations only.

The first attempt timed out; one retry was made. After the prompt, an unsolicited auto-mode setup offer appeared. Subsequent typed input entered that dialog instead of reliably reaching the main prompt; its setup flow was not completed. No transition below has structured evidence of execution. The session was stopped, and the probe's known transcript, associated session directory, temporary hook files and PID file were removed. No trust prompt was accepted. The probe did not use a controller spawn token, HTTP hooks, or a statusline endpoint, so it cannot directly establish controller routing or statusline behavior.

## Results and gaps

| Action | Observation | Confidence / remaining gap |
| --- | --- | --- |
| Startup with `--session-id` | Startup hook and PID session file reported the supplied ID; the prompt transcript used it too. | High for startup only; this does not establish whether the ID survives `/clear`. |
| `/clear`, `/reset`, `/new` | Inputs were intercepted by the auto-mode dialog; no new `SessionStart` was observed. | Inconclusive; no inference about old/new IDs or alias behavior. |
| Explicit `/resume` of the probe's own session | Input was intercepted by the dialog. | Inconclusive; no evidence of a completed resume. |
| `/branch` | Input was intercepted by the dialog. | Inconclusive; no evidence of a branch or resulting ID. |
| `/cd` to the disposable target | Input was intercepted by the dialog. | Inconclusive; neither PID cwd, transcript location/header, nor terminal header after a successful move was established. |
| Worktree | Not attempted: intentionally excluded due to expense and side effects. | Unverified. |

In particular, whether `/clear` overrides the initial `--session-id`, whether a controller's unchanged spawn token would still route to an old controller session ID, and which cwd and transcript path a successful `/cd` reports remain **unverified**, not negative findings. The CLI reference describes `/clear` as starting a new conversation, `/branch` as switching to a conversation branch, and `/cd` as moving the working directory while keeping the conversation; these are documented semantics, not successful observations from this run.

## Recommended boundary

Keep the current guards for identity/cwd-changing commands and use the controller's existing create/resume controls rather than sending those commands into its PTY. Do not infer a native transition from a terminal repaint or assume a spawn token changes identity. Supporting native transitions would require a separately verified lifecycle design using structured session and cwd signals, transcript ownership and routing reconciliation, plus explicit handling for picker/dialog races. Do not broaden the allowed command set based on this inconclusive probe.
