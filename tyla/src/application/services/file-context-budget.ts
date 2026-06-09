/**
 * Service: FileContextBudget
 *
 * A mutable, per-turn token pool for the tutor `file_context`.
 *
 * gap-list §C (2026-06-07): the base auto-read (`readFiles` / `readFallbackFiles`)
 * must honour the same caps as a B3 continuation load. Each base file is otherwise
 * only bounded by the 100k-char file_read cap (≈25k tokens), so even the base
 * context alone can be several times the backend's ~8K budget and trip
 * whole-or-drop on turn 0 — before any loop runs. One instance is created per turn
 * and threaded through every read so that base files (and, once the B3 driver
 * lands, continuation loads) draw down a single shared pool:
 *
 *   per-file cap — no single file may dominate the pool.
 *   per-turn cap — base + loaded combined; once spent, further files are refused
 *                  with a visible marker (`skipMarker`), never silently dropped.
 */

import { estimateTokens } from '../prompts';

/**
 * Below this many remaining tokens, appending another (truncated) file yields a
 * near-useless fragment — treat the pool as spent and refuse with a marker.
 */
const MIN_USEFUL_TOKENS = 100;

export class FileContextBudget {
    private remaining: number;

    constructor(
        private readonly perFileCap: number,
        perTurnCap: number,
    ) {
        this.remaining = perTurnCap;
    }

    /** True once too little of the per-turn pool remains to seat another file. */
    isExhausted(): boolean {
        return this.remaining < MIN_USEFUL_TOKENS;
    }

    /**
     * Truncate `content` to the smaller of the per-file cap and what is left of
     * the per-turn pool, draw the (re-measured) result down from the pool, and
     * return the labelled block ready to concatenate into file_context.
     *
     * The `slice(cap * 4)` step assumes ~4 chars/token (English / R source); the
     * draw-down re-measures the truncated body with `estimateTokens`, so the pool
     * accounting stays accurate even when the slice overshoots for CJK text.
     */
    take(label: string, content: string): string {
        const cap = Math.min(this.perFileCap, this.remaining);
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
