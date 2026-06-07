/**
 * Domain Policy: TextContentPolicy
 *
 * Heuristic binary/text sniff used by the B3 continuation file loader before
 * decoding a buffer as UTF-8. Kept as a standalone pure function so it can be
 * unit-tested without any I/O and reused by any future caller that needs the
 * same decision.
 *
 * Rules (in order):
 *   1. Empty buffer → treat as text (no harmful content).
 *   2. Any NUL byte (0x00) → binary.
 *   3. Control characters other than \t (0x09), \n (0x0a), \r (0x0d)
 *      make up > 30 % of the sampled prefix → binary.
 *
 * Only the first SNIFF_BYTES bytes are examined; the rest are assumed to match
 * the prefix, which is sufficient for detecting binary formats whose magic
 * bytes appear at the start of the file.
 */

const SNIFF_BYTES = 8_000;
const NONTEXT_RATIO_LIMIT = 0.3;

/**
 * Returns true when `buf` is most likely a human-readable text file.
 * Returns false for binary files (executables, images, compressed archives, …).
 */
export function isProbablyText(buf: Buffer): boolean {
    const n = Math.min(buf.length, SNIFF_BYTES);
    if (n === 0) return true;

    let suspicious = 0;
    for (let i = 0; i < n; i++) {
        const b = buf[i];
        if (b === 0) return false; // NUL byte → definitely binary
        const isControl = b < 0x09 || (b > 0x0d && b < 0x20);
        if (isControl) suspicious++;
    }
    return suspicious / n <= NONTEXT_RATIO_LIMIT;
}
