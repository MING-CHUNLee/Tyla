/**
 * Service: line numbering for tutor file_context (plan 2026-06-11 §2.1)
 *
 * Front-end ↔ back-end convention: every line of a live workspace file sent to
 * the tutor is prefixed with its REAL file line number, right-aligned:
 *
 *     1| library(ggplot2)
 *     2| d123 <- rnorm(100)
 *
 * The LLM copies these prefixes verbatim into `edit_file.patches[].search`
 * (the anchoring key) and omits them in `replace`. add/strip are kept in the
 * same module so the format stays symmetric.
 *
 * Strip regex: /^\s*\d+\| ?/ — `|` was chosen over tab/arrow because R's `|>`
 * never appears at line start right after a digit, so false strips are
 * negligible.
 */

const PREFIX_RE = /^\s*\d+\| ?/;
const PARSE_RE = /^\s*(\d+)\| ?(.*)$/;

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

export interface AnchoredLine {
    /** 1-based real-file line number parsed from the prefix. */
    lineNo: number;
    /** Line content with the prefix removed (may keep a trailing \r from CRLF input). */
    text: string;
}

/**
 * Parse a numbered snippet into anchored lines. Returns the lines only when
 * EVERY line carries a number prefix and the numbers are strictly consecutive
 * — anything else returns null so callers fall back to plain text search.
 */
export function parseNumberedLines(s: string): AnchoredLine[] | null {
    if (s === '') return null;
    const raw = s.endsWith('\n') ? s.slice(0, -1) : s;
    const lines = raw.split('\n');
    const anchored: AnchoredLine[] = [];
    for (const line of lines) {
        const m = PARSE_RE.exec(line);
        if (!m) return null;
        const lineNo = Number(m[1]);
        const prev = anchored[anchored.length - 1];
        if (prev && lineNo !== prev.lineNo + 1) return null;
        anchored.push({ lineNo, text: m[2] });
    }
    return anchored;
}
