/**
 * Unit Tests: EditStagingService
 *
 * IFileSystem and DiffEngine are injected as mocks — no real disk I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditStagingService, StagedEdit } from '../../../src/application/services/edit-staging-service';
import { IFileSystem } from '../../../src/domain/types/file-system';
import { DiffEngine } from '../../../src/application/services/diff-engine';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockFs(overrides: Partial<IFileSystem> = {}): IFileSystem {
    return {
        exists: vi.fn().mockReturnValue(false),
        read: vi.fn().mockReturnValue(''),
        write: vi.fn(),
        mkdir: vi.fn(),
        stat: vi.fn(),
        ...overrides,
    } as unknown as IFileSystem;
}

function makeMockDiff(): DiffEngine {
    return {
        generateColoredDiff: vi.fn().mockReturnValue('+ new line\n- old line\n'),
    } as unknown as DiffEngine;
}

function makeService(fsOverrides?: Partial<IFileSystem>) {
    const fs = makeMockFs(fsOverrides);
    const diff = makeMockDiff();
    const service = new EditStagingService(fs, diff);
    return { service, fs, diff };
}

// ── stage() ───────────────────────────────────────────────────────────────────

describe('EditStagingService', () => {
    describe('stage()', () => {
        it('treats a non-existent file as new (original = "")', () => {
            const { service, fs } = makeService({ exists: vi.fn().mockReturnValue(false) });

            const result = service.stage('new-file.R', 'x <- 1\n');

            expect('staged' in result).toBe(true);
            const { staged } = result as { staged: StagedEdit };
            expect(staged.original).toBe('');
            expect(staged.content).toBe('x <- 1\n');
            expect(fs.read).not.toHaveBeenCalled();
        });

        it('reads original content from disk when file exists', () => {
            const { service, fs } = makeService({
                exists: vi.fn().mockReturnValue(true),
                read: vi.fn().mockReturnValue('old content\n'),
            });

            const result = service.stage('existing.R', 'new content\n');

            expect(fs.read).toHaveBeenCalled();
            const { staged } = result as { staged: StagedEdit };
            expect(staged.original).toBe('old content\n');
        });

        it('computes a diff and stores it in the staged edit', () => {
            const { service, diff } = makeService({
                exists: vi.fn().mockReturnValue(true),
                read: vi.fn().mockReturnValue('old\n'),
            });

            const result = service.stage('file.R', 'new\n');

            expect(diff.generateColoredDiff).toHaveBeenCalledWith('old\n', 'new\n');
            const { staged } = result as { staged: StagedEdit };
            expect(staged.diff).toBe('+ new line\n- old line\n');
        });

        it('returns a soft error (isHardError: false) when content is identical', () => {
            const { service } = makeService({
                exists: vi.fn().mockReturnValue(true),
                read: vi.fn().mockReturnValue('same content\n'),
            });

            const result = service.stage('file.R', 'same content\n');

            expect('error' in result).toBe(true);
            const err = result as { error: string; isHardError: boolean };
            expect(err.isHardError).toBe(false);
            expect(err.error).toContain('No changes detected');
        });

        it('returns a hard error when the file cannot be read', () => {
            const { service } = makeService({
                exists: vi.fn().mockReturnValue(true),
                read: vi.fn().mockImplementation(() => { throw new Error('EACCES'); }),
            });

            const result = service.stage('locked.R', 'content\n');

            expect('error' in result).toBe(true);
            const err = result as { error: string; isHardError: boolean };
            expect(err.isHardError).toBe(true);
            expect(err.error).toContain('Cannot read');
        });

        it('does not push to the queue on failure', () => {
            const { service } = makeService({
                exists: vi.fn().mockReturnValue(true),
                read: vi.fn().mockReturnValue('same\n'),
            });

            service.stage('file.R', 'same\n');
            const drained = service.drainStagedEdits();

            expect(drained).toHaveLength(0);
        });
    });

    // ── drainStagedEdits() ────────────────────────────────────────────────────

    describe('drainStagedEdits()', () => {
        it('returns all staged edits', () => {
            const { service } = makeService({ exists: vi.fn().mockReturnValue(false) });

            service.stage('a.R', 'content a\n');
            service.stage('b.R', 'content b\n');
            const drained = service.drainStagedEdits();

            expect(drained).toHaveLength(2);
            expect(drained.map(e => e.path)).toContain('a.R');
            expect(drained.map(e => e.path)).toContain('b.R');
        });

        it('clears the queue after draining', () => {
            const { service } = makeService({ exists: vi.fn().mockReturnValue(false) });

            service.stage('a.R', 'content\n');
            service.drainStagedEdits();
            const second = service.drainStagedEdits();

            expect(second).toHaveLength(0);
        });
    });

    // ── stageFromArtifacts() ──────────────────────────────────────────────────

    describe('stageFromArtifacts()', () => {
        const dir = '/project';
        const emit = vi.fn();

        beforeEach(() => {
            emit.mockClear();
        });

        it('stages an artifact when content differs from disk', () => {
            const { service } = makeService({
                read: vi.fn().mockReturnValue('old\n'),
            });

            const result = service.stageFromArtifacts([{ path: 'a.R', content: 'new\n' }], dir, emit);

            expect(result).toHaveLength(1);
            expect(result[0].path).toBe('a.R');
        });

        it('skips an artifact when content is identical to disk', () => {
            const { service } = makeService({
                read: vi.fn().mockReturnValue('same\n'),
            });

            const result = service.stageFromArtifacts([{ path: 'a.R', content: 'same\n' }], dir, emit);

            expect(result).toHaveLength(0);
        });

        it('treats ENOENT as a new file (original = "")', () => {
            const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
            const { service } = makeService({
                read: vi.fn().mockImplementation(() => { throw enoent; }),
            });

            const result = service.stageFromArtifacts([{ path: 'new.R', content: 'content\n' }], dir, emit);

            expect(result).toHaveLength(1);
            expect(result[0].original).toBe('');
        });

        it('emits an error and skips artifact on non-ENOENT read failure', () => {
            const ioErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
            const { service } = makeService({
                read: vi.fn().mockImplementation(() => { throw ioErr; }),
            });

            const result = service.stageFromArtifacts([{ path: 'locked.R', content: 'x\n' }], dir, emit);

            expect(result).toHaveLength(0);
            expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ phase: 'review' }));
        });
    });

    // ── stageOnly() ───────────────────────────────────────────────────────────

    describe('stageOnly()', () => {
        it('does NOT push to the drain queue (stage + apply leave drain empty)', () => {
            const { service } = makeService({
                exists: vi.fn().mockReturnValue(true),
                read: vi.fn().mockReturnValue('old\n'),
            });

            const result = service.stageOnly('hw11.R', 'new\n', '/project');
            expect('staged' in result).toBe(true);

            const { staged } = result as { staged: StagedEdit };
            service.applyEdit(staged);

            expect(service.drainStagedEdits()).toHaveLength(0);
        });

        it('keeps the relative path for display and resolves absPath against baseDir', () => {
            const { service } = makeService({
                exists: vi.fn().mockReturnValue(false),
            });

            const result = service.stageOnly('hw11.R', 'x <- 1\n', '/project');
            const { staged } = result as { staged: StagedEdit };

            expect(staged.path).toBe('hw11.R');               // relative for the diff header
            expect(staged.absPath).toContain('hw11.R');
            expect(staged.absPath).toContain('project');      // resolved against baseDir
        });

        it('applyEdit writes to the carried absPath (tutor directory, not cwd)', () => {
            const { service, fs } = makeService({ exists: vi.fn().mockReturnValue(false) });

            const result = service.stageOnly('hw11.R', 'x <- 1\n', '/project');
            const { staged } = result as { staged: StagedEdit };
            service.applyEdit(staged);

            const [writtenPath] = (fs.write as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(writtenPath).toBe(staged.absPath);
        });

        it('returns a soft error when content is identical', () => {
            const { service } = makeService({
                exists: vi.fn().mockReturnValue(true),
                read: vi.fn().mockReturnValue('same\n'),
            });

            const result = service.stageOnly('hw11.R', 'same\n', '/project');

            const err = result as { error: string; isHardError: boolean };
            expect(err.isHardError).toBe(false);
            expect(err.error).toContain('No changes detected');
        });
    });

    // ── applyEdit() ───────────────────────────────────────────────────────────

    describe('applyEdit()', () => {
        it('calls mkdir then write with the resolved absolute path', () => {
            const { service, fs } = makeService();
            const edit: StagedEdit = {
                path: 'analysis.R',
                content: 'x <- 1\n',
                original: '',
                diff: '',
            };

            service.applyEdit(edit);

            expect(fs.mkdir).toHaveBeenCalledTimes(1);
            expect(fs.write).toHaveBeenCalledTimes(1);

            const [writtenPath, writtenContent] = (fs.write as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(writtenPath).toContain('analysis.R');
            expect(writtenContent).toBe('x <- 1\n');
        });
    });
});
