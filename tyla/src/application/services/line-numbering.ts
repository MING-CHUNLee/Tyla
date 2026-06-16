/**
 * Service: line numbering for tutor file_context (plan 2026-06-11 §2.1; patch
 * contract updated 2026-06-13).
 *
 * Front-end → back-end convention: every line of a live workspace file sent to
 * the tutor is prefixed with its REAL file line number, right-aligned:
 *
 *     1| library(ggplot2)
 *     2| d123 <- rnorm(100)
 *
 * The LLM READS these prefixes to fill `edit_file.patches[].start_line` (the
 * anchoring key, plan 2026-06-13 §2) and keeps `search`/`replace` as PLAIN
 * content — no prefixes. `stripLineNumberPrefixes` survives as a defensive net
 * for a model that still jams a prefix into search/replace out of old habit
 * (plan §7 D4); the apply algorithm anchors on `start_line`, not on parsing
 * prefixes out of `search`.
 *
 * Strip regex: /^\s*\d+\| ?/ — `|` was chosen over tab/arrow because R's `|>`
 * never appears at line start right after a digit, so false strips are
 * negligible.
 */

const PREFIX_RE = /^\s*\d+\| ?/;

/**
 * Prefix every line with its 1-based line number (`  1| code`), right-aligned
 * to the widest number. A trailing newline is preserved without numbering the
 * phantom empty line after it. Empty input returns empty.
 */
export function addLineNumbers(text: string): string {
    if (text === '') return '';
    const hasTrailingNewline = text.endsWith('\n');
    const body = hasTrailingNewline ? text.slice(0, -1) : text;
    const lines = body.split('\n');
    const width = String(lines.length).length;
    const numbered = lines
        .map((line, i) => `${String(i + 1).padStart(width)}| ${line}`)
        .join('\n');
    return hasTrailingNewline ? `${numbered}\n` : numbered;
}

/** Defensively remove a `N| ` prefix from every line that carries one. */
export function stripLineNumberPrefixes(text: string): string {
    return text
        .split('\n')
        .map(line => line.replace(PREFIX_RE, ''))
        .join('\n');
}

/**
 * Reduce a tutor `file_context` to its headers-only block: keep the `### <path>`
 * heading lines, drop every `N| ` content line and per-block marker (plan Option C
 * §3.2). This is the materials the backend parses `seen_paths` from — the frontend
 * only WRITES these `### path` headers (it is the file_context producer); the backend
 * owns the parse. Returns '' for empty / header-less input.
 */
export function toHeadersOnlyBlock(fileContext: string): string {
    if (!fileContext) return '';
    return fileContext
        .split('\n')
        .filter(line => line.startsWith('### '))
        .join('\n');
}
