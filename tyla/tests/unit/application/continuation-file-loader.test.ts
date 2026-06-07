/**
 * Unit Tests: ContinuationFileLoader.resolve
 *
 * Covers the six failure cases and two success cases from the B3 implementation
 * plan §5 (G7+G8+G10):
 *
 *   confine failure   → marker + `unresolved:` key
 *   budget exhausted  → skipMarker
 *   binary file       → unsupported type marker
 *   PDF too large     → pre-filter marker
 *   PDF parse error   → parse failed marker
 *   PDF empty text    → no extractable text marker
 *   plain text ok     → content block (key = canonicalPath, ok: true)
 *   PDF ok            → content block (key = canonicalPath, ok: true)
 *
 * PathConfinement is injected and mocked; no real filesystem is needed.
 * FileContextBudget is used as a real instance to keep token-accounting honest.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContinuationFileLoader } from '../../../src/application/services/continuation-file-loader';
import { FileContextBudget } from '../../../src/application/services/file-context-budget';
import { PathConfinement } from '../../../src/domain/policies/path-confinement';
import type { ConfinementFailureReason } from '../../../src/domain/policies/path-confinement';
import type { IFileSystem } from '../../../src/domain/types/file-system';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROOT = '/project';
const CANONICAL_TXT = '/project/data/hw.R';
const CANONICAL_PDF = '/project/data/report.pdf';

function okConfinement(canon: string): PathConfinement {
    return {
        resolveWithinRoot: vi.fn().mockReturnValue({ ok: true, canonicalPath: canon }),
    } as unknown as PathConfinement;
}

function failConfinement(reason: ConfinementFailureReason): PathConfinement {
    return {
        resolveWithinRoot: vi.fn().mockReturnValue({ ok: false, reason, message: 'mock error' }),
    } as unknown as PathConfinement;
}

function makeFs(buf: Buffer = Buffer.from('hello world\n')): IFileSystem {
    return {
        readBuffer: vi.fn().mockReturnValue(buf),
        realpath: vi.fn().mockImplementation((p: string) => p),
        exists: vi.fn().mockReturnValue(true),
        read: vi.fn(),
        write: vi.fn(),
        mkdir: vi.fn(),
        stat: vi.fn(),
    } as unknown as IFileSystem;
}

function freshBudget(perFileCap = 1200, perTurnCap = 2200): FileContextBudget {
    return new FileContextBudget(perFileCap, perTurnCap);
}

function noPdf(): (buf: Buffer) => Promise<string> {
    return vi.fn().mockRejectedValue(new Error('should not be called'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ContinuationFileLoader.resolve', () => {

    // ── Confinement failures ──────────────────────────────────────────────────

    it('returns unresolved key and marker when path escapes workspace root', async () => {
        const loader = new ContinuationFileLoader(makeFs(), failConfinement('escape'), noPdf());
        const r = await loader.resolve(ROOT, '../secret.txt', freshBudget());

        expect(r.ok).toBe(false);
        expect(r.key).toBe('unresolved:escape:../secret.txt');
        expect(r.block).toContain('unavailable (escape)');
        expect(r.block).toContain('do not request this file again');
    });

    it('uses the trimmed requested path in the unresolved key', async () => {
        const loader = new ContinuationFileLoader(makeFs(), failConfinement('empty'), noPdf());
        const r = await loader.resolve(ROOT, '   ', freshBudget());

        expect(r.key).toBe('unresolved:empty:');   // trim of '   ' is ''
        expect(r.ok).toBe(false);
    });

    it('returns unresolved key with absolute reason when absolute path requested', async () => {
        const loader = new ContinuationFileLoader(makeFs(), failConfinement('absolute'), noPdf());
        const r = await loader.resolve(ROOT, '/etc/passwd', freshBudget());

        expect(r.key).toMatch(/^unresolved:absolute:/);
        expect(r.ok).toBe(false);
    });

    // ── Budget exhaustion ─────────────────────────────────────────────────────

    it('returns skipMarker when budget is already exhausted', async () => {
        const exhaustedBudget = new FileContextBudget(1, 0); // 0 remaining → isExhausted() = true
        const loader = new ContinuationFileLoader(makeFs(), okConfinement(CANONICAL_TXT), noPdf());
        const r = await loader.resolve(ROOT, 'data/hw.R', exhaustedBudget);

        expect(r.ok).toBe(false);
        expect(r.key).toBe(CANONICAL_TXT);
        expect(r.block).toContain('skipped: file-context token budget exhausted');
    });

    // ── Text files ────────────────────────────────────────────────────────────

    it('loads a plain text file and returns ok: true with labelled block', async () => {
        const content = 'x <- 1\ny <- 2\n';
        const loader = new ContinuationFileLoader(
            makeFs(Buffer.from(content)),
            okConfinement(CANONICAL_TXT),
            noPdf(),
        );
        const r = await loader.resolve(ROOT, 'data/hw.R', freshBudget());

        expect(r.ok).toBe(true);
        expect(r.key).toBe(CANONICAL_TXT);
        expect(r.block).toContain('### hw.R');
        expect(r.block).toContain(content.trim());
    });

    it('returns binary marker for a buffer containing a NUL byte', async () => {
        const binaryBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x61, 0x62]); // ZIP header with NUL
        const loader = new ContinuationFileLoader(
            makeFs(binaryBuf),
            okConfinement(CANONICAL_TXT),
            noPdf(),
        );
        const r = await loader.resolve(ROOT, 'data/hw.R', freshBudget());

        expect(r.ok).toBe(false);
        expect(r.key).toBe(CANONICAL_TXT);
        expect(r.block).toContain('unsupported type (binary)');
        expect(r.block).toContain('do not request this file again');
    });

    it('handles readBuffer throwing (file disappears after confine)', async () => {
        const throwingFs = {
            readBuffer: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        } as unknown as IFileSystem;
        const loader = new ContinuationFileLoader(throwingFs, okConfinement(CANONICAL_TXT), noPdf());
        const r = await loader.resolve(ROOT, 'data/hw.R', freshBudget());

        expect(r.ok).toBe(false);
        expect(r.key).toBe(CANONICAL_TXT);
        expect(r.block).toContain('unavailable (read error:');
        expect(r.block).toContain('ENOENT');
    });

    // ── PDF files ─────────────────────────────────────────────────────────────

    it('returns pdf-too-large marker when PDF buffer exceeds 5 MB', async () => {
        const oversizedBuf = Buffer.alloc(5_000_001, 0x25); // 5 MB + 1, no NUL
        const loader = new ContinuationFileLoader(
            makeFs(oversizedBuf),
            okConfinement(CANONICAL_PDF),
            noPdf(),
        );
        const r = await loader.resolve(ROOT, 'data/report.pdf', freshBudget());

        expect(r.ok).toBe(false);
        expect(r.block).toContain('unavailable (pdf too large)');
    });

    it('returns parse-failed marker when extractPdf throws', async () => {
        const failExtract = vi.fn().mockRejectedValue(new Error('corrupted PDF'));
        const loader = new ContinuationFileLoader(
            makeFs(Buffer.from('%PDF-1.4')),
            okConfinement(CANONICAL_PDF),
            failExtract,
        );
        const r = await loader.resolve(ROOT, 'data/report.pdf', freshBudget());

        expect(r.ok).toBe(false);
        expect(r.block).toContain('unavailable (pdf parse failed)');
    });

    it('returns no-extractable-text marker when extractPdf resolves with blank text', async () => {
        const emptyExtract = vi.fn().mockResolvedValue('   '); // whitespace-only
        const loader = new ContinuationFileLoader(
            makeFs(Buffer.from('%PDF-1.4')),
            okConfinement(CANONICAL_PDF),
            emptyExtract,
        );
        const r = await loader.resolve(ROOT, 'data/report.pdf', freshBudget());

        expect(r.ok).toBe(false);
        expect(r.block).toContain('unavailable (no extractable text)');
    });

    it('loads a PDF successfully and returns ok: true with labelled block', async () => {
        const pdfText = 'This is the PDF content.\nPage 1 of 1.\n';
        const okExtract = vi.fn().mockResolvedValue(pdfText);
        const loader = new ContinuationFileLoader(
            makeFs(Buffer.from('%PDF-1.4')),
            okConfinement(CANONICAL_PDF),
            okExtract,
        );
        const r = await loader.resolve(ROOT, 'data/report.pdf', freshBudget());

        expect(r.ok).toBe(true);
        expect(r.key).toBe(CANONICAL_PDF);
        expect(r.block).toContain('### report.pdf');
        expect(r.block).toContain(pdfText.trim());
    });

    // ── Budget truncation (text) ───────────────────────────────────────────────

    it('still returns ok: true when content is truncated by the token budget', async () => {
        // Tiny budget: perTurnCap=200, enough to seat something but less than a big file
        const tightBudget = new FileContextBudget(50, 200);
        const bigContent = 'A'.repeat(10_000); // well above 200-token budget
        const loader = new ContinuationFileLoader(
            makeFs(Buffer.from(bigContent)),
            okConfinement(CANONICAL_TXT),
            noPdf(),
        );
        const r = await loader.resolve(ROOT, 'data/hw.R', tightBudget);

        expect(r.ok).toBe(true);
        expect(r.block).toContain('truncated for token budget');
    });
});
