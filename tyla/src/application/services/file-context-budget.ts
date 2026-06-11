/**
 * Service: FileContextBudget
 *
 * A mutable, per-turn token pool for the tutor `file_context`.
 *
 * One instance is created per turn and threaded through every read so that
 * @-mentioned base files and B3 continuation loads draw down a single shared
 * pool; once spent, further files are refused with a visible marker
 * (`skipMarker`), never silently dropped. The pool is the last line of defence
 * against the backend's whole-or-drop `context_overflow`.
 *
 * The per-file cap was removed (plan 2026-06-11, decision 3): with @-gating
 * only files the student explicitly named are loaded, so a single file may
 * fill the whole pool — there is no "irrelevant auto-loaded file eats the
 * budget" failure mode any more.
 */

import { estimateTokens } from '../prompts';

/**
 * Below this many remaining tokens, appending another (truncated) file yields a
 * near-useless fragment — treat the pool as spent and refuse with a marker.
 */
const MIN_USEFUL_TOKENS = 100;

export class FileContextBudget {
    private remaining: number;

    constructor(perTurnCap: number) {
        this.remaining = perTurnCap;
    }

    /** True once too little of the per-turn pool remains to seat another file. */
    isExhausted(): boolean {
        return this.remaining < MIN_USEFUL_TOKENS;
    }

    /**
     * Truncate `content` to what is left of the per-turn pool, draw the
     * (re-measured) result down from the pool, and return the labelled block
     * ready to concatenate into file_context.
     *
     * The `slice(cap * 4)` step assumes ~4 chars/token (English / R source); the
     * draw-down re-measures the truncated body with `estimateTokens`, so the pool
     * accounting stays accurate even when the slice overshoots for CJK text.
     */
    take(label: string, content: string): string {
        const cap = this.remaining;
        let body = content;
        if (estimateTokens(body) > cap) {
            // ~4 chars/token for English/R source; may undercount dense code — recalibrate in Phase 0.
            body = body.slice(0, cap * 4) + '\n[…truncated for token budget]';
        }
        this.remaining -= estimateTokens(body);
        return `### ${label}\n${body}\n\n`;
    }

    /** Marker appended in place of a file that didn't fit — never a silent drop. */
    skipMarker(label: string): string {
        return `### ${label}\n[skipped: file-context token budget exhausted]\n\n`;
    }
}
