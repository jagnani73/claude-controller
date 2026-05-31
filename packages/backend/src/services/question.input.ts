// Translates a structured AskUserQuestion answer into a sequence of raw bytes
// that drive Claude Code's ink-based question UI via PTY stdin. The CLI accepts
// these the same way it accepts a human pressing keys: arrow keys to move the
// option cursor, Space to toggle multi-select checkboxes, Enter to select/submit,
// Tab to advance between questions in a batched call, Esc to cancel.
//
// The function is pure — it returns a single string of bytes to write. Caller
// is responsible for passing it to `pty.write()` (NOT `sendInput`, which wraps
// in bracketed paste and would treat the escape sequences as literal text).

import type { AnswerEntry, QuestionSchema } from "common/types";

const KEY = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RETURN: "\r",
  TAB: "\t",
  ESC: "\x1b",
  SPACE: " ",
  /** Opens the notes input on a preview question (PreviewQuestionView). */
  NOTE: "n",
} as const;

export interface BuildKeystrokesArgs {
  questions: QuestionSchema[];
  answers: AnswerEntry[];
  cancel?: boolean;
}

export interface KeystrokeChunk {
  bytes: string;
  /** ms to wait AFTER writing this chunk before the next. Defaults to
   *  CHUNK_DELAY_MS. A few ink transitions are heavier than a plain keystroke
   *  and need more settle time, or the following chunk lands before the
   *  outgoing component releases input focus and gets swallowed. */
  settleMs?: number;
}

/**
 * Sequence of byte chunks to write to the PTY, with mandatory delays between
 * chunks. The chunks model React/ink's state-flush boundaries: when one
 * keystroke needs to observe state set by an earlier one, they must land in
 * separate render passes, which only happens if there's enough wall time
 * between the writes for ink to re-render. Single-chunk scripts collapse to
 * one write with no waiting.
 */
export interface KeystrokeScript {
  chunks: KeystrokeChunk[];
}

/** Milliseconds between chunks. Empirically enough for ink to process each
 *  keystroke in its own render pass — multiple arrow keys arriving in the
 *  same Node tick were being absorbed by useReducer/useInput closures and
 *  not advancing focus past the first DOWN. */
export const CHUNK_DELAY_MS = 35;

/** Settle time after exiting the preview notes input. The exit unmounts the
 *  TextInput and re-registers the option-nav input handler — heavier than a
 *  keystroke — so the following select Enter must wait longer or it's
 *  swallowed by the still-mounted notes field (option never gets selected). */
const NOTES_EXIT_SETTLE_MS = 200;

export function buildKeystrokes(args: BuildKeystrokesArgs): KeystrokeScript {
  if (args.cancel) return { chunks: [{ bytes: KEY.ESC }] };

  const batched = args.questions.length > 1;
  const chunks: KeystrokeChunk[] = [];

  // Each question's script is responsible for advancing one page: single-select
  // commits with Enter (which auto-advances), multi-select appends a Tab after
  // its Space toggles. So we DON'T add an inter-question Tab here — doing so
  // would double-advance and skip a question.
  for (let qi = 0; qi < args.questions.length; qi++) {
    const q = args.questions[qi];
    const a = args.answers[qi] ?? {};
    chunks.push(...buildQuestionKeystrokes(q, a, { batched }));
  }

  // After the last question advances, a batched flow sits on the review screen
  // (currentQuestionIndex === questions.length). Its default-focused option is
  // "Submit answers", so one Enter confirms.
  if (batched) chunks.push({ bytes: KEY.RETURN });

  return { chunks: chunks.filter((c) => c.bytes.length > 0) };
}

function buildQuestionKeystrokes(
  q: QuestionSchema,
  a: AnswerEntry,
  ctx: { batched: boolean },
): KeystrokeChunk[] {
  const chunks: KeystrokeChunk[] = [];
  let position = 0; // cursor row, 0 = first option
  const emit = (bytes: string, settleMs?: number): void => {
    chunks.push({ bytes, settleMs });
  };

  // Each arrow keystroke goes out as its own chunk (with a delay between
  // sends in the WS handler). Sending several escape sequences in one PTY
  // write lets ink batch the dispatches against a single render's stale
  // closure, so only the first DOWN actually advances focus.
  const moveTo = (target: number): void => {
    const delta = target - position;
    const step = delta > 0 ? KEY.DOWN : KEY.UP;
    const count = Math.abs(delta);
    for (let i = 0; i < count; i++) emit(step);
    position = target;
  };

  const otherIdx = q.optionLabels.length;
  const submitIdx = otherIdx + 1; // multi-select "Submit/Next" button

  if (q.multiSelect) {
    if (a.selectedLabels?.length) {
      for (const label of a.selectedLabels) {
        const idx = q.optionLabels.indexOf(label);
        if (idx < 0) continue;
        moveTo(idx);
        emit(KEY.SPACE);
      }
    }
    if (a.customText) {
      moveTo(otherIdx);
      // Type text as one chunk — TextInput handles it as a paste-like burst.
      emit(a.customText);
      // Commit the typed value into the "Other" row's selected state.
      emit(KEY.RETURN);
    }
    // Space already committed each toggle. In a batch, Tab turns the page (and
    // from the last question advances to the review screen, since the nav bar's
    // maxIndex === questions.length). Standalone, navigate to the Submit button
    // and press Enter.
    if (ctx.batched) {
      emit(KEY.TAB);
    } else {
      moveTo(submitIdx);
      emit(KEY.RETURN);
    }
    return chunks;
  }

  // Single-select. Arrow keys only MOVE focus — they never commit. The answer
  // is recorded by Enter (select:accept), which in a batch also auto-advances
  // to the next question. (Omitting this Enter when batched was the bug that
  // silently dropped navigated single-select answers.)
  const label = a.selectedLabels?.[0];
  const idx = label ? q.optionLabels.indexOf(label) : -1;

  // Preview-question note: pick an option AND attach a note. Notes live in the
  // PreviewQuestionView "n" input (no "Other" row exists on preview screens, so
  // the customText path would steer into the footer and fire "Chat about this").
  // Focus the option FIRST, then open notes and type. Exit with Esc, NOT Enter:
  // the notes TextInput's onSubmit doesn't fire on Enter here (confirmed in PTY
  // captures — Enter left the field open), but the view's own key handler exits
  // notes on Esc (handleNotesExit). Esc doesn't auto-advance (nothing selected
  // yet), then the select Enter commits + advances. The Esc carries a longer
  // settle so the select Enter doesn't arrive while the notes field still owns
  // input (it'd be swallowed and no option would get selected).
  //
  // Gated on `hasPreview`: the notes input only exists on the preview view, so
  // driving `n` on a plain question would land in the footer (→ "Chat about
  // this"). The client only sets `notes` for preview questions, but gating here
  // keeps a stray `notes` on a non-preview question from corrupting the answer.
  if (a.notes && idx >= 0 && q.hasPreview) {
    moveTo(idx); // focus the chosen option while still in option-nav
    emit(KEY.NOTE); // open notes input
    emit(a.notes, NOTES_EXIT_SETTLE_MS); // type the note; let it register before Esc
    emit(KEY.ESC, NOTES_EXIT_SETTLE_MS); // exit notes (Esc → handleNotesExit, no advance)
    emit(KEY.RETURN); // select the focused option → commit + advance
    return chunks;
  }

  if (a.customText) {
    moveTo(otherIdx);
    emit(a.customText);
    emit(KEY.RETURN);
    return chunks;
  }

  if (idx >= 0) {
    moveTo(idx);
    emit(KEY.RETURN);
    return chunks;
  }

  // No resolvable answer (shouldn't happen — submit is gated on all-answered).
  // In a batch we still must advance so later questions don't land on this page.
  if (ctx.batched) emit(KEY.TAB);
  return chunks;
}
