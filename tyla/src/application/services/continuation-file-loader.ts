/**
 * Service: ContinuationFileLoader
 *
 * The single truth source for B3 continuation loads (G7+G8+G10). Any file the
 * LLM requests via a `load_file` action passes through exactly one path:
 *
 *   PathConfinement → budget check → readBuffer → binary sniff / PDF extract
 *                  → FileContextBudget.take / marker
 *
 * Callers receive a `LoadResolution` they can append directly to file_context
 * without knowing whether the load succeeded or was refused. Every failure
 * produces a model-facing marker that tells the model to stop re-requesting
 * the same file (b3 §4.10, risk 1).
 *
 * Deliberately does NOT reuse FileReadService (which encodes the ask/ReAct
 * 100k-char cap and has no token-budget awareness).
 */

import path from 'path';
import { IFileSystem } from '../../domain/types/file-system';
import { PathConfinement } from '../../domain/policies/path-confinement';
import { isProbablyText } from '../../domain/policies/text-content-policy';
import { FileContextBudget } from './file-context-budget';
import { addLineNumbers } from './line-numbering';

export interface LoadResolution {
    /** Dedup key: success → canonicalPath; failure → `unresolved:<reason>:<req>` (§2.5). */
    key: string;
    /** true when content was loaded into the block; false for markers. */
    ok: boolean;
    /** Labelled content block or model-facing marker — ready to append as-is. */
    block: string;
}

/** Raw-byte pre-filter: PDF parsing is expensive; reject oversized buffers before even trying. */
const MAX_PDF_BYTES = 5_000_000;

export class ContinuationFileLoader {
    constructor(
        private readonly fileSystem: IFileSystem,
        private readonly confinement: PathConfinement,
        private readonly extractPdf: (buf: Buffer) => Promise<string>,
    ) {}

    async resolve(root: string, requested: string, budget: FileContextBudget): Promise<LoadResolution> {
        const c = this.confinement.resolveWithinRoot(root, requested);
        if (!c.ok) {
            const key = `unresolved:${c.reason}:${requested.trim()}`;
            return { key, ok: false, block: marker(requested, `unavailable (${c.reason})`) };
        }

        const label = path.basename(c.canonicalPath);

        if (budget.isExhausted()) {
            return { key: c.canonicalPath, ok: false, block: budget.skipMarker(label) };
        }

        let buf: Buffer;
        try {
            buf = this.fileSystem.readBuffer(c.canonicalPath);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { key: c.canonicalPath, ok: false, block: marker(label, `unavailable (read error: ${msg})`) };
        }

        const isPdf = path.extname(c.canonicalPath).toLowerCase() === '.pdf';

        if (isPdf) {
            if (buf.length > MAX_PDF_BYTES) {
                return { key: c.canonicalPath, ok: false, block: marker(label, 'unavailable (pdf too large)') };
            }
            let text: string;
            try {
                text = await this.extractPdf(buf);
            } catch {
                return { key: c.canonicalPath, ok: false, block: marker(label, 'unavailable (pdf parse failed)') };
            }
            if (!text.trim()) {
                return { key: c.canonicalPath, ok: false, block: marker(label, 'unavailable (no extractable text)') };
            }
            return { key: c.canonicalPath, ok: true, block: budget.take(label, text) };
        }

        if (!isProbablyText(buf)) {
            return { key: c.canonicalPath, ok: false, block: marker(label, 'unsupported type (binary)') };
        }
        // Real-file line numbers (plan 2026-06-11 §2.1) — they anchor edit_file
        // patches. Budget truncation keeps the head, so numbers stay correct.
        // PDFs above stay un-numbered: extracted text has no anchorable file lines.
        return { key: c.canonicalPath, ok: true, block: budget.take(label, addLineNumbers(buf.toString('utf8'))) };
    }
}

function marker(label: string, why: string): string {
    return `### ${label}\n[${why} — do not request this file again]\n\n`;
}
