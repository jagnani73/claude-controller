import type { ParsedHandler } from "../types/index.js";

// ─── ANSI Escape Patterns ───────────────────────────────────────────

/** Cursor forward \x1b[nC → convert to n spaces before stripping */
const CURSOR_FORWARD = /\x1b\[(\d+)C/g;

/** CSI sequences: \x1b[ ... letter */
const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** OSC sequences: \x1b] ... BEL or ST */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Single-char escape sequences */
const ESC_SINGLE = /\x1b[()#][A-Z0-9]/g;

/** Device control / private sequences */
const DCS = /\x1b[><=][^\x1b]*/g;

/** Bare ESC followed by a single char (catch-all for remaining) */
const ESC_MISC = /\x1b[A-Z@[\]^_`a-z{|}~]/g;

/** BEL character on its own */
const BEL = /\x07/g;

/** Carriage return not followed by newline (overwrites) */
const CR_ONLY = /\r(?!\n)/g;

// ─── Noise Patterns ─────────────────────────────────────────────────

const SPINNER_CHARS = new Set(["✻", "✶", "✽", "*", "✢", "·", "✳"]);

/** Horizontal rule: 4+ box-drawing characters */
const HORIZONTAL_RULE = /^─{4,}$/;

/** Status bar pattern */
const STATUS_BAR = /^(Sonnet|Opus|Haiku)\s+[\d.]+\s*\|\s*(?:ctx|id)/;

export class ParserService {
    private handlers: ParsedHandler[] = [];
    private lastEmittedText = "";
    private spinnerDebounce: ReturnType<typeof setTimeout> | null = null;
    private pendingSpinnerText: string | null = null;

    /** Register a handler for parsed clean text */
    onParsed(handler: ParsedHandler): void {
        this.handlers.push(handler);
    }

    /** Feed raw PTY data into the parser */
    feed(rawChunk: string): void {
        const clean = this.stripAnsi(rawChunk);
        if (!clean) return;

        const lines = clean.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            this.processLine(trimmed);
        }
    }

    /** Reset parser state */
    reset(): void {
        this.lastEmittedText = "";
        this.pendingSpinnerText = null;
        if (this.spinnerDebounce) {
            clearTimeout(this.spinnerDebounce);
            this.spinnerDebounce = null;
        }
    }

    // ─── Layer 1: ANSI Stripping ────────────────────────────────────

    private stripAnsi(text: string): string {
        let result = text;

        // Convert cursor-forward to spaces BEFORE stripping
        result = result.replace(CURSOR_FORWARD, (_match, n) => {
            return " ".repeat(Number.parseInt(n, 10));
        });

        // Strip all escape sequences
        result = result.replace(OSC, "");
        result = result.replace(CSI, "");
        result = result.replace(ESC_SINGLE, "");
        result = result.replace(DCS, "");
        result = result.replace(ESC_MISC, "");
        result = result.replace(BEL, "");

        // Handle carriage returns (overwrite behavior)
        result = result.replace(CR_ONLY, "\n");

        // Collapse multiple spaces (from cursor positioning)
        result = result.replace(/ {3,}/g, "  ");

        return result;
    }

    // ─── Layer 2: Noise Filtering ───────────────────────────────────

    private processLine(line: string): void {
        // Skip horizontal rules
        if (HORIZONTAL_RULE.test(line)) return;

        // Skip status bar lines (we'll parse these properly later)
        if (STATUS_BAR.test(line)) return;

        // Detect spinner lines
        const firstChar = line[0];
        if (firstChar && SPINNER_CHARS.has(firstChar)) {
            this.handleSpinner(line);
            return;
        }

        // Skip lines that are just spinner residue
        if (this.isSpinnerResidue(line)) return;

        // Deduplicate: skip if identical to last emitted
        if (line === this.lastEmittedText) return;

        this.emit(line);
    }

    private handleSpinner(line: string): void {
        // Extract the text after the spinner character
        const text = line.slice(1).trim();
        if (!text) return;

        // Deduplicate spinner content — only emit when text changes
        if (text === this.pendingSpinnerText) return;
        this.pendingSpinnerText = text;

        // Debounce spinner emissions to 1 per second
        if (this.spinnerDebounce) {
            clearTimeout(this.spinnerDebounce);
        }
        this.spinnerDebounce = setTimeout(() => {
            if (this.pendingSpinnerText) {
                this.emit(`[spinner] ${this.pendingSpinnerText}`);
            }
            this.spinnerDebounce = null;
        }, 1000);
    }

    private isSpinnerResidue(line: string): boolean {
        // Lines that are just "Slithering..." or "(thinking with X effort)"
        // without a preceding marker — these are partial spinner redraws
        if (/^(Slithering|Proofing|Thinking)…/.test(line)) return true;
        if (/^\(thinking with (low|medium|high) effort\)$/.test(line))
            return true;
        if (/^\(thought for \d+s\)$/.test(line)) {
            // Thought completion is meaningful — emit it
            this.emit(line);
            return true;
        }
        return false;
    }

    // ─── Emit ───────────────────────────────────────────────────────

    private emit(text: string): void {
        this.lastEmittedText = text;
        for (const handler of this.handlers) {
            handler(text);
        }
    }
}
