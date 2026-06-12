/**
 * Unit Tests: ExecuteTutorUseCase — Option B (backend guard → tutor → actions).
 *
 * The offline fallback was removed (decision doc §1); execute() always routes through the
 * gateways. Mock gateways are injected via deps — no axios / network.
 */

import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { ExecuteTutorUseCase, ExecuteTutorDeps } from '../../../src/application/use-cases/execute-tutor-use-case';
import { ToolRegistry } from '../../../src/application/orchestration/tool-registry';
import { GuardCheckGateway } from '../../../src/infrastructure/api/guard/guard-check-gateway';
import { TutorChatGateway } from '../../../src/infrastructure/api/tutor/tutor-chat-gateway';
import { IFileSystem } from '../../../src/domain/types/file-system';
import { DiffEngine } from '../../../src/application/services/diff-engine';
import { estimateTokens } from '../../../src/application/prompts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGuard(result: unknown) {
    return { check: vi.fn().mockResolvedValue(result) } as unknown as GuardCheckGateway;
}
function makeTutor(result: unknown) {
    return { send: vi.fn().mockResolvedValue(result) } as unknown as TutorChatGateway;
}
function makeFs(overrides: Partial<IFileSystem> = {}): IFileSystem {
    return {
        exists:    vi.fn().mockReturnValue(true),
        read:      vi.fn().mockReturnValue('old code'),
        readBuffer: vi.fn().mockReturnValue(Buffer.from('old code')),
        write:     vi.fn(),
        mkdir:     vi.fn(),
        stat:      vi.fn(),
        realpath:  vi.fn().mockImplementation((p: string) => path.resolve(p)),
        ...overrides,
    } as unknown as IFileSystem;
}
function makeDiff(): DiffEngine {
    return {
        generateColoredDiff: vi.fn().mockReturnValue('coloured-diff'),
        generateDiffLines:   vi.fn().mockReturnValue([]),
    } as unknown as DiffEngine;
}

const GUARD_DONE = { status: 'done', logId: 42, guardSkipped: false, usage: { inputTokens: 1, outputTokens: 2 } };

function makeOptionB(overrides: {
    guard?: unknown;
    tutor?: unknown;
    onApproval?: (e: unknown) => Promise<boolean>;
    registryGet?: (name: string) => unknown;
    fileSystem?: IFileSystem;
} = {}) {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const emit = (type: string, data: Record<string, unknown>) => events.push({ type, data });

    const registryGet = vi.fn(overrides.registryGet ?? (() => undefined));
    const registry = { get: registryGet, register: vi.fn(), getSchemas: vi.fn().mockReturnValue([]) } as unknown as ToolRegistry;

    const deps: ExecuteTutorDeps = {
        registry,
        directory: '/project',
        emit,
        guardCheckGateway: makeGuard(overrides.guard ?? GUARD_DONE),
        tutorChatGateway: makeTutor(overrides.tutor ?? {
            status: 'done', logId: 7, content: 'Here is a hint', actions: [],
            guardSkipped: false, usage: { inputTokens: 3, outputTokens: 4 },
        }),
        onApproval: overrides.onApproval,
        fileSystem: overrides.fileSystem ?? makeFs(),
        diffEngine: makeDiff(),
    };

    return { deps, events, registryGet };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ExecuteTutorUseCase — Option B', () => {
    it('guard forbidden short-circuits before the tutor call', async () => {
        const { deps, events } = makeOptionB({
            guard: { status: 'forbidden', logId: 1, refusal: 'Not allowed.', usage: { inputTokens: 1, outputTokens: 0 } },
        });
        const useCase = new ExecuteTutorUseCase(deps);

        const result = await useCase.execute('do my homework', []);

        expect((deps.tutorChatGateway!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(result.content).toBe('Not allowed.');
        expect(events.some(e => e.type === 'guard_blocked')).toBe(true);
    });

    it('guard error emits an error and does not call the tutor', async () => {
        const { deps, events } = makeOptionB({
            guard: { status: 'error', message: 'judge down', usage: { inputTokens: 0, outputTokens: 0 } },
        });
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('help', []);

        expect((deps.tutorChatGateway!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const err = events.find(e => e.type === 'error');
        expect(err?.data.message).toContain('Safety check failed');
    });

    it('tutor error emits an error and dispatches no actions', async () => {
        const { deps, events } = makeOptionB({
            tutor: { status: 'error', logId: 7, content: 'boom', usage: { inputTokens: 1, outputTokens: 1 } },
        });
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('help', []);

        const err = events.find(e => e.type === 'error' && e.data.phase === 'tutor');
        expect(err?.data.message).toContain('Tutor call failed');
        expect(events.some(e => e.type === 'diff_proposed')).toBe(false);
    });

    it('done path calls the tutor with the guard logId and sums usage', async () => {
        const { deps, events } = makeOptionB();
        const useCase = new ExecuteTutorUseCase(deps);

        const result = await useCase.execute('explain recursion', []);

        const sendMock = deps.tutorChatGateway!.send as ReturnType<typeof vi.fn>;
        expect(sendMock).toHaveBeenCalled();
        expect(sendMock.mock.calls[0][2]).toBe(42);          // guardLogId threaded through
        expect(result.usage.inputTokens).toBe(1 + 3);        // guard + tutor
        expect(result.usage.outputTokens).toBe(2 + 4);
        expect(events.some(e => e.type === 'text_output' && e.data.content === 'Here is a hint')).toBe(true);
    });

    it('edit_file action applies only when approved', async () => {
        const fileSystem = makeFs();
        const { deps, events } = makeOptionB({
            tutor: {
                status: 'done', logId: 7, content: 'Try this',
                actions: [{ type: 'edit_file', path: 'hw11.R', patches: [{ search: 'old', replace: 'new' }] }],
                guardSkipped: false, usage: { inputTokens: 3, outputTokens: 4 },
            },
            onApproval: vi.fn().mockResolvedValue(true),
            fileSystem,
        });
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('fix my code', []);

        expect(events.some(e => e.type === 'diff_proposed')).toBe(true);
        expect(events.some(e => e.type === 'edit_applied' && e.data.path === 'hw11.R')).toBe(true);
        expect(fileSystem.write).toHaveBeenCalled();
    });

    it('edit_file action is rejected when approval is declined', async () => {
        const fileSystem = makeFs();
        const { deps, events } = makeOptionB({
            tutor: {
                status: 'done', logId: 7, content: 'Try this',
                actions: [{ type: 'edit_file', path: 'hw11.R', patches: [{ search: 'old', replace: 'new' }] }],
                guardSkipped: false, usage: { inputTokens: 3, outputTokens: 4 },
            },
            onApproval: vi.fn().mockResolvedValue(false),
            fileSystem,
        });
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('fix my code', []);

        expect(events.some(e => e.type === 'edit_rejected' && e.data.path === 'hw11.R')).toBe(true);
        expect(fileSystem.write).not.toHaveBeenCalled();
    });

    it('backend warnings are surfaced as status_update warnings (§2.7)', async () => {
        const { deps, events } = makeOptionB({
            tutor: {
                status: 'done', logId: 7, content: 'hint', actions: [],
                guardSkipped: false, usage: { inputTokens: 1, outputTokens: 1 },
                warnings: ['file_context_dropped', 'history_truncated', 'reference_loaded'],
            },
        });
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('help', []);

        const warnings = events
            .filter(e => e.type === 'status_update' && typeof e.data.warning === 'string')
            .map(e => e.data.warning as string);
        expect(warnings.some(w => w.includes('檔案內容超過後端預算'))).toBe(true);
        expect(warnings.some(w => w.includes('對話歷史過長'))).toBe(true);
        expect(warnings.some(w => w.includes('調閱了參考解答'))).toBe(true);
    });

    it('execute_script rejected emits script_rejected and never runs r_exec', async () => {
        const rExec = { execute: vi.fn() };
        const { deps, events, registryGet } = makeOptionB({
            tutor: {
                status: 'done', logId: 7, content: 'Run this',
                actions: [{ type: 'execute_script', code: 'print(1)' }],
                guardSkipped: false, usage: { inputTokens: 3, outputTokens: 4 },
            },
            onApproval: vi.fn().mockResolvedValue(false),
            registryGet: (name: string) => (name === 'r_exec' ? rExec : undefined),
        });
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('run my script', []);

        expect(events.some(e => e.type === 'script_proposed')).toBe(true);
        expect(events.some(e => e.type === 'script_rejected')).toBe(true);
        expect(rExec.execute).not.toHaveBeenCalled();
        expect(registryGet).not.toHaveBeenCalledWith('r_exec');
    });
});

// ── file_context: @-gating + per-turn token budget (plan 2026-06-11 §2.4) ─────
// Content reads are @-gated: only files the student names with `@<file>` are
// loaded. The per-file cap is gone — a single named file may fill the whole
// per-turn pool (default 6,000 tokens); only past the pool is it truncated.

/** ~`tokens` tokens of ASCII (estimateTokens ≈ chars/4 for English). */
function bigContent(tokens: number): string {
    return 'x'.repeat(tokens * 4);
}

/**
 * Registry exposing file_scan (one rScripts group) paired with a fileSystem whose
 * readBuffer uses `contentFor(canonicalPath)`.  ContinuationFileLoader reads files
 * via fileSystem.readBuffer — NOT via the file_read tool — so the fileSystem mock
 * is the correct injection point for budget tests.
 */
function makeReadRegistry(
    files: Array<{ name: string; path: string }>,
    contentFor: (filePath: string) => string,
): { registryGet: (name: string) => unknown; fileSystem: IFileSystem } {
    const fileScan = {
        execute: vi.fn().mockResolvedValue({ content: 'scan summary', data: { files: { rScripts: files } } }),
    };
    const fileSystem = makeFs({
        readBuffer: vi.fn().mockImplementation((p: string) => Buffer.from(contentFor(p))),
    });
    return {
        registryGet: (name: string) => (name === 'file_scan' ? fileScan : undefined),
        fileSystem,
    };
}

/** Pull the file_context (4th arg) handed to tutorChatGateway.send(). */
function capturedFileContext(deps: ExecuteTutorDeps): string {
    const send = deps.tutorChatGateway!.send as ReturnType<typeof vi.fn>;
    return send.mock.calls[0][3] as string;
}

describe('ExecuteTutorUseCase — @-gated file_context (plan 2026-06-11 §2.4)', () => {
    it('omits the File Contents block when the instruction has no @ mention', async () => {
        const files = [{ name: 'hw2.R', path: '/project/hw2.R' }];
        const setup = makeReadRegistry(files, () => 'x <- 1\n');
        const { deps } = makeOptionB(setup);
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('explain my homework please', []);

        const fileContext = capturedFileContext(deps);
        expect(fileContext).toContain('## Project Context');      // name-only list stays
        expect(fileContext).not.toContain('## File Contents');
        expect(setup.fileSystem.readBuffer).not.toHaveBeenCalled();
    });

    it('loads an @-mentioned scanned file with line-number prefixes', async () => {
        const files = [{ name: 'hw2.R', path: '/project/hw2.R' }];
        const { deps } = makeOptionB(makeReadRegistry(files, () => 'x <- 1\ny <- 2\n'));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('please look at @hw2.R', []);

        const fileContext = capturedFileContext(deps);
        expect(fileContext).toContain('## File Contents');
        expect(fileContext).toContain('### hw2.R');
        expect(fileContext).toContain('1| x <- 1\n2| y <- 2');
    });

    it('matches @ tokens against scanned basenames case-insensitively', async () => {
        const files = [{ name: 'hw2.R', path: '/project/hw2.R' }];
        const { deps } = makeOptionB(makeReadRegistry(files, () => 'x <- 1\n'));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('check @HW2.r for me', []);

        expect(capturedFileContext(deps)).toContain('### hw2.R');
    });

    it('@ pointing at a nonexistent file yields an unavailable marker + warning', async () => {
        const files = [{ name: 'hw2.R', path: '/project/hw2.R' }];
        const setup = makeReadRegistry(files, () => 'x <- 1\n');
        // realpath throws for the unscanned token → confinement 'not-found'
        (setup.fileSystem.realpath as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
            if (p.includes('missing')) throw new Error('ENOENT');
            return path.resolve(p);
        });
        const { deps, events } = makeOptionB(setup);
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('check @missing.R', []);

        const fileContext = capturedFileContext(deps);
        expect(fileContext).toContain('unavailable (not-found)');
        expect(events.some(e => e.type === 'status_update'
            && typeof e.data.warning === 'string'
            && (e.data.warning as string).includes('missing.R'))).toBe(true);
    });
});

describe('ExecuteTutorUseCase — file_context budget (per-turn pool only)', () => {
    it('lets a single @-mentioned file fill the whole per-turn pool untruncated', async () => {
        const files = [{ name: 'f0.R', path: '/project/f0.R' }];
        // 5,000 tokens < 6,000-token pool — no per-file cap any more.
        const { deps } = makeOptionB(makeReadRegistry(files, () => bigContent(5_000)));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('explain @f0.R', []);

        expect(capturedFileContext(deps)).not.toContain('[…truncated for token budget]');
    });

    it('truncates a single file only past the per-turn pool', async () => {
        const files = [{ name: 'f0.R', path: '/project/f0.R' }];
        const { deps } = makeOptionB(makeReadRegistry(files, () => bigContent(7_000)));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('explain @f0.R', []);

        const fileContext = capturedFileContext(deps);
        expect(fileContext).toContain('[…truncated for token budget]');
        expect(estimateTokens(fileContext)).toBeLessThan(6_500);
    });

    it('refuses @-files past the per-turn budget with a marker (not a silent drop)', async () => {
        const files = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.R`, path: `/project/f${i}.R` }));
        const { deps, events } = makeOptionB(makeReadRegistry(files, () => bigContent(2_500)));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('explain @f0.R @f1.R @f2.R @f3.R', []);

        const fileContext = capturedFileContext(deps);
        // per-turn pool (~6,000) keeps the whole base context bounded …
        expect(estimateTokens(fileContext)).toBeLessThan(6_500);
        // … and the overflow files are refused with a visible marker, not dropped.
        expect(fileContext).toContain('[skipped: file-context token budget exhausted]');
        expect(events.some(e => e.type === 'status_update'
            && typeof e.data.warning === 'string'
            && (e.data.warning as string).includes('token budget reached'))).toBe(true);
    });

    it('leaves small @-mentioned files untouched (no truncation, no skip)', async () => {
        const files = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.R`, path: `/project/f${i}.R` }));
        const { deps } = makeOptionB(makeReadRegistry(files, p => `content of ${path.basename(p)}`));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute('explain @f0.R @f1.R @f2.R', []);

        const fileContext = capturedFileContext(deps);
        expect(fileContext).not.toContain('[…truncated for token budget]');
        expect(fileContext).not.toContain('[skipped: file-context token budget exhausted]');
        expect(fileContext).toContain('content of f0.R');
        expect(fileContext).toContain('content of f2.R');
    });
});

// ── edit_file numbered patches (plan 2026-06-11 §2.3) ─────────────────────────
// Layer 1: line-number anchors locate the exact lines (duplicates resolved);
// Layer 2: stale/missing anchors fall back to first-occurrence text search.

const PATCH_ORIGINAL = [
    'x <- 1',
    'quantile(d, probs = 0.5)',
    'y <- 2',
    'quantile(d, probs = 0.5)',
    'z <- 3',
].join('\n');

function makePatchSetup(patches: Array<{ search: string; replace: string }>) {
    const fileSystem = makeFs({ read: vi.fn().mockReturnValue(PATCH_ORIGINAL) });
    const { deps, events } = makeOptionB({
        tutor: {
            status: 'done', logId: 7, content: 'Patching',
            actions: [{ type: 'edit_file', path: 'hw11.R', patches }],
            guardSkipped: false, usage: { inputTokens: 1, outputTokens: 1 },
        },
        fileSystem,
    });
    return { deps, events };
}

function proposedContent(events: Array<{ type: string; data: Record<string, unknown> }>): string {
    return events.find(e => e.type === 'diff_proposed')?.data.proposed as string;
}

describe('ExecuteTutorUseCase — edit_file numbered patches (§2.3)', () => {
    it('anchored patch edits the numbered occurrence, not the first duplicate', async () => {
        const { deps, events } = makePatchSetup([
            { search: '4| quantile(d, probs = 0.5)', replace: 'quantile(d, probs = 0.95)' },
        ]);
        await new ExecuteTutorUseCase(deps).execute('fix line 4', []);

        expect(proposedContent(events)).toBe([
            'x <- 1',
            'quantile(d, probs = 0.5)',          // line 2 (first occurrence) untouched
            'y <- 2',
            'quantile(d, probs = 0.95)',
            'z <- 3',
        ].join('\n'));
    });

    it('stale anchor falls back to text search with a warning', async () => {
        // line 5 is 'z <- 3', not 'y <- 2' → anchor mismatch → text fallback hits line 3.
        const { deps, events } = makePatchSetup([
            { search: '5| y <- 2', replace: 'y <- 99' },
        ]);
        await new ExecuteTutorUseCase(deps).execute('fix it', []);

        expect(proposedContent(events)).toContain('y <- 99');
        expect(events.some(e => e.type === 'status_update'
            && typeof e.data.warning === 'string'
            && (e.data.warning as string).includes('line anchor 5 did not match'))).toBe(true);
    });

    it('applies multiple anchored patches bottom-up so earlier anchors survive', async () => {
        const { deps, events } = makePatchSetup([
            { search: '1| x <- 1', replace: 'x0 <- 0\nx <- 1' },   // inserts a line above the rest
            { search: '5| z <- 3', replace: 'z <- 30' },
        ]);
        await new ExecuteTutorUseCase(deps).execute('two edits', []);

        expect(proposedContent(events)).toBe([
            'x0 <- 0',
            'x <- 1',
            'quantile(d, probs = 0.5)',
            'y <- 2',
            'quantile(d, probs = 0.5)',
            'z <- 30',
        ].join('\n'));
    });

    it('strips stray line-number prefixes from replace defensively', async () => {
        const { deps, events } = makePatchSetup([
            { search: '3| y <- 2', replace: '3| y <- 42' },
        ]);
        await new ExecuteTutorUseCase(deps).execute('fix it', []);

        const proposed = proposedContent(events);
        expect(proposed).toContain('y <- 42');
        expect(proposed).not.toContain('3|');
    });

    it('un-numbered patch keeps the first-occurrence text-search behaviour', async () => {
        const { deps, events } = makePatchSetup([
            { search: 'quantile(d, probs = 0.5)', replace: 'quantile(d, probs = 0.25)' },
        ]);
        await new ExecuteTutorUseCase(deps).execute('fix it', []);

        expect(proposedContent(events)).toBe([
            'x <- 1',
            'quantile(d, probs = 0.25)',          // first occurrence replaced …
            'y <- 2',
            'quantile(d, probs = 0.5)',           // … second untouched
            'z <- 3',
        ].join('\n'));
    });
});
