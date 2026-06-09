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

// ── file_context token budget (gap-list §C) ────────────────────────────────────
// The base auto-read (readFallbackFiles → readFiles) must honour the same per-file
// and per-turn token caps as a continuation load, or the base context alone trips
// the backend's whole-or-drop on turn 0. PER_FILE_TOKEN_CAP=1200, per-turn=2200.

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

describe('ExecuteTutorUseCase — file_context budget (§C)', () => {
    // Instruction with no filename match and no 'r' (avoids the single-letter ext
    // match) so buildFileContext falls through to readFallbackFiles (top-5 auto-load).
    const NO_MATCH = 'explain please';

    it('caps a single oversized base file to the per-file budget', async () => {
        const files = [{ name: 'f0.R', path: '/project/f0.R' }];
        const { deps } = makeOptionB(makeReadRegistry(files, () => bigContent(5_000)));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute(NO_MATCH, []);

        const fileContext = capturedFileContext(deps);
        expect(fileContext).toContain('[…truncated for token budget]');
        // one file, capped per-file (~1200) — nowhere near the raw 5,000 tokens.
        expect(estimateTokens(fileContext)).toBeLessThan(1_600);
    });

    it('refuses base files past the per-turn budget with a marker (not a silent drop)', async () => {
        const files = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.R`, path: `/project/f${i}.R` }));
        const { deps, events } = makeOptionB(makeReadRegistry(files, () => bigContent(1_000)));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute(NO_MATCH, []);

        const fileContext = capturedFileContext(deps);
        // per-turn pool (~2200) keeps the whole base context bounded …
        expect(estimateTokens(fileContext)).toBeLessThan(2_600);
        // … and the overflow files are refused with a visible marker, not dropped.
        expect(fileContext).toContain('[skipped: file-context token budget exhausted]');
        expect(events.some(e => e.type === 'status_update'
            && typeof e.data.warning === 'string'
            && (e.data.warning as string).includes('token budget reached'))).toBe(true);
    });

    it('leaves small base files untouched (no truncation, no skip)', async () => {
        const files = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.R`, path: `/project/f${i}.R` }));
        const { deps } = makeOptionB(makeReadRegistry(files, p => `content of ${p}`));
        const useCase = new ExecuteTutorUseCase(deps);

        await useCase.execute(NO_MATCH, []);

        const fileContext = capturedFileContext(deps);
        expect(fileContext).not.toContain('[…truncated for token budget]');
        expect(fileContext).not.toContain('[skipped: file-context token budget exhausted]');
        // path.resolve normalises the fake POSIX root to the platform canonical form
        expect(fileContext).toContain(`content of ${path.resolve('/project', 'f0.R')}`);
        expect(fileContext).toContain(`content of ${path.resolve('/project', 'f2.R')}`);
    });
});
