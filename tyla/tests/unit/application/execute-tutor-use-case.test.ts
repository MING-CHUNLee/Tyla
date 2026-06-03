/**
 * Unit Tests: ExecuteTutorUseCase — Option B (backend guard → tutor → actions).
 *
 * The offline fallback was removed (decision doc §1); execute() always routes through the
 * gateways. Mock gateways are injected via deps — no axios / network.
 */

import { describe, it, expect, vi } from 'vitest';
import { ExecuteTutorUseCase, ExecuteTutorDeps } from '../../../src/application/use-cases/execute-tutor-use-case';
import { ToolRegistry } from '../../../src/application/orchestration/tool-registry';
import { GuardCheckGateway } from '../../../src/infrastructure/api/guard/guard-check-gateway';
import { TutorChatGateway } from '../../../src/infrastructure/api/tutor/tutor-chat-gateway';
import { IFileSystem } from '../../../src/domain/types/file-system';
import { DiffEngine } from '../../../src/application/services/diff-engine';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGuard(result: unknown) {
    return { check: vi.fn().mockResolvedValue(result) } as unknown as GuardCheckGateway;
}
function makeTutor(result: unknown) {
    return { send: vi.fn().mockResolvedValue(result) } as unknown as TutorChatGateway;
}
function makeFs(overrides: Partial<IFileSystem> = {}): IFileSystem {
    return {
        exists: vi.fn().mockReturnValue(true),
        read: vi.fn().mockReturnValue('old code'),
        readBuffer: vi.fn(),
        write: vi.fn(),
        mkdir: vi.fn(),
        stat: vi.fn(),
        ...overrides,
    } as unknown as IFileSystem;
}
function makeDiff(): DiffEngine {
    return { generateColoredDiff: vi.fn().mockReturnValue('coloured-diff') } as unknown as DiffEngine;
}

const GUARD_DONE = { status: 'done', logId: 42, guardSkipped: false, usage: { inputTokens: 1, outputTokens: 2 } };

function makeOptionB(overrides: {
    guard?: unknown;
    tutor?: unknown;
    onApproval?: (e: unknown) => Promise<boolean>;
    registryGet?: (name: string) => unknown;
    fileSystem?: IFileSystem;
    omitGuardGateway?: boolean;
} = {}) {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const emit = (type: string, data: Record<string, unknown>) => events.push({ type, data });

    const registryGet = vi.fn(overrides.registryGet ?? (() => undefined));
    const registry = { get: registryGet, register: vi.fn(), getSchemas: vi.fn().mockReturnValue([]) } as unknown as ToolRegistry;

    const deps: ExecuteTutorDeps = {
        registry,
        directory: '/project',
        emit,
        guardCheckGateway: overrides.omitGuardGateway ? undefined : makeGuard(overrides.guard ?? GUARD_DONE),
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
    it('throws a friendly error (not a TypeError) when the guard gateway is absent', async () => {
        const { deps, events } = makeOptionB({ omitGuardGateway: true });
        const useCase = new ExecuteTutorUseCase(deps, 'tutor-guide');

        await expect(useCase.execute('help', [])).rejects.toThrow(/backend not configured/i);

        expect((deps.tutorChatGateway!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const err = events.find(e => e.type === 'error');
        expect(err?.data.message).toMatch(/backend not configured/i);
    });

    it('guard forbidden short-circuits before the tutor call', async () => {
        const { deps, events } = makeOptionB({
            guard: { status: 'forbidden', logId: 1, refusal: 'Not allowed.', usage: { inputTokens: 1, outputTokens: 0 } },
        });
        const useCase = new ExecuteTutorUseCase(deps, 'tutor-guide');

        const result = await useCase.execute('do my homework', []);

        expect((deps.tutorChatGateway!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(result.content).toBe('Not allowed.');
        expect(events.some(e => e.type === 'guard_blocked')).toBe(true);
    });

    it('guard error emits an error and does not call the tutor', async () => {
        const { deps, events } = makeOptionB({
            guard: { status: 'error', message: 'judge down', usage: { inputTokens: 0, outputTokens: 0 } },
        });
        const useCase = new ExecuteTutorUseCase(deps, 'tutor-guide');

        await useCase.execute('help', []);

        expect((deps.tutorChatGateway!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const err = events.find(e => e.type === 'error');
        expect(err?.data.message).toContain('Safety check failed');
    });

    it('tutor error emits an error and dispatches no actions', async () => {
        const { deps, events } = makeOptionB({
            tutor: { status: 'error', logId: 7, content: 'boom', usage: { inputTokens: 1, outputTokens: 1 } },
        });
        const useCase = new ExecuteTutorUseCase(deps, 'tutor-guide');

        await useCase.execute('help', []);

        const err = events.find(e => e.type === 'error' && e.data.phase === 'tutor');
        expect(err?.data.message).toContain('Tutor call failed');
        expect(events.some(e => e.type === 'diff_proposed')).toBe(false);
    });

    it('done path calls the tutor with the guard logId and sums usage', async () => {
        const { deps, events } = makeOptionB();
        const useCase = new ExecuteTutorUseCase(deps, 'tutor-guide');

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
        const useCase = new ExecuteTutorUseCase(deps, 'tutor-guide');

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
        const useCase = new ExecuteTutorUseCase(deps, 'tutor-guide');

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
        const useCase = new ExecuteTutorUseCase(deps, 'tutor-guide');

        await useCase.execute('run my script', []);

        expect(events.some(e => e.type === 'script_proposed')).toBe(true);
        expect(events.some(e => e.type === 'script_rejected')).toBe(true);
        expect(rExec.execute).not.toHaveBeenCalled();
        expect(registryGet).not.toHaveBeenCalledWith('r_exec');
    });
});
