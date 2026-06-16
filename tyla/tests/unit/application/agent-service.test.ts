/**
 * Unit Tests: AgentController (alias AgentService)
 *
 * Uses fully assembled mock deps (pre-built use cases + buses) to isolate the
 * controller from real LLM calls, filesystem I/O, and session persistence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    AgentService,
    type AgentServiceDeps,
    type AgentEvent,
} from '../../../src/application/services/agent-service';
import { EventBus } from '../../../src/application/services/event-bus';
import { ModeManager } from '../../../src/application/services/mode-manager';
import { ConversationSession } from '../../../src/domain/entities/conversation-session';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../src/infrastructure/config/settings', () => ({
    getSettings: vi.fn().mockReturnValue({ statusBar: { items: [] }, workflowMode: 'default' }),
    saveSettings: vi.fn(),
}));

vi.mock('../../../src/infrastructure/persistence/knowledge-repository', () => ({
    KnowledgeRepository: vi.fn(function() {
        return { load: vi.fn().mockReturnValue([]) };
    }),
}));

// ── Shared zero-usage sentinel ────────────────────────────────────────────────

const ZERO_USAGE = {
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
};

// ── Factories ─────────────────────────────────────────────────────────────────

function makeMockRepo() {
    return {
        load: vi.fn().mockResolvedValue(null),
        loadLast: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(undefined),
    };
}

/**
 * Build a minimal AgentServiceDeps with mock use cases.
 *
 * @param intentResult   - what the mock IntentRouter.classify() resolves to
 * @param askContent     - content returned by the mock ask use case
 */
function makeService(
    intentResult: 'ask' | 'edit' | 'run' | 'install' = 'ask',
    askContent = 'Test answer',
): {
    service: AgentService;
    events: AgentEvent[];
    eventBus: EventBus;
    repo: ReturnType<typeof makeMockRepo>;
    mockAskUseCase: { execute: ReturnType<typeof vi.fn> };
    mockIntentRouter: { classify: ReturnType<typeof vi.fn> };
} {
    const events: AgentEvent[] = [];
    const eventBus = new EventBus();
    const repo = makeMockRepo();

    const mockAskUseCase = {
        execute: vi.fn().mockResolvedValue({ content: askContent, usage: ZERO_USAGE }),
    };

    const mockIntentRouter = {
        classify: vi.fn().mockResolvedValue(intentResult),
    };

    const mockInstructionUseCase = {
        execute: vi.fn().mockResolvedValue({
            appliedFiles: [],
            outputs: [],
            validatedEdits: [],
            usage: ZERO_USAGE,
            analysisSummary: 'edit result',
        }),
    };

    const mockRunUseCase = {
        execute: vi.fn().mockResolvedValue({
            scriptPath: null,
            execOutput: '',
            analysis: 'run result',
            usage: ZERO_USAGE,
        }),
    };

    const mockInstallUseCase = {
        execute: vi.fn().mockResolvedValue({ content: 'installed', usage: ZERO_USAGE }),
    };

    const mockTutorUseCase = {
        execute: vi.fn().mockResolvedValue({ content: 'tutor response', usage: ZERO_USAGE }),
    };

    const deps: AgentServiceDeps = {
        askUseCase:         mockAskUseCase as never,
        instructionUseCase: mockInstructionUseCase as never,
        runUseCase:         mockRunUseCase as never,
        tutorUseCase:       mockTutorUseCase as never,
        installUseCase:     mockInstallUseCase as never,
        intentRouter:        mockIntentRouter as never,
        summarizer: {
            shouldSummarize: vi.fn().mockReturnValue(false),
            summarize: vi.fn().mockResolvedValue([]),
        } as never,
        pluginLoader: { loadAll: async () => [] },
        modeManager: new ModeManager(),
        repo,
        initialModel: 'claude-test',
        eventBus,
    };

    const service = new AgentService(
        { directory: '/fake/project' },
        (event) => events.push(event),
        deps,
    );

    return { service, events, eventBus, repo, mockAskUseCase, mockIntentRouter };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentService', () => {
    describe('initialize()', () => {
        it('creates a new session when no prior session exists', async () => {
            const { service, events } = makeService();
            await service.initialize();

            const loaded = events.find(e => e.type === 'session_loaded');
            expect(loaded).toBeDefined();
            expect(loaded!.data.turnCount).toBe(0);
        });

        it('uses initialModel from deps for session model name', async () => {
            const { service, events } = makeService();
            await service.initialize();

            const loaded = events.find(e => e.type === 'session_loaded');
            expect(loaded!.data.model).toBe('claude-test');
        });

        it('getSession() returns the initialized session', async () => {
            const { service } = makeService();
            await service.initialize();

            const session = service.getSession();
            expect(session).toBeDefined();
            expect(session.model).toBe('claude-test');
        });

        it('throws if getSession() called before initialize()', () => {
            const { service } = makeService();
            expect(() => service.getSession()).toThrow('not initialized');
        });
    });

    describe('executeInstruction() — ask mode', () => {
        it('routes to askUseCase when IntentRouter returns "ask"', async () => {
            const { service, mockAskUseCase } = makeService('ask');
            await service.initialize();

            await service.executeInstruction('What does this function do?');

            // The real IntentRouter emits intent_classified; the mock doesn't.
            // Controller-level assertion: correct use case was invoked.
            expect(mockAskUseCase.execute).toHaveBeenCalledWith(
                'What does this function do?',
                expect.any(Array),
                expect.any(String),
            );
        });

        it('calls askUseCase.execute and emits turn_saved', async () => {
            const { service, events, mockAskUseCase } = makeService('ask');
            await service.initialize();

            await service.executeInstruction('explain this code');

            expect(mockAskUseCase.execute).toHaveBeenCalled();
            const saved = events.find(e => e.type === 'turn_saved');
            expect(saved).toBeDefined();
        });

        it('emits stream_token events when askUseCase emits them via EventBus', async () => {
            const { service, events, eventBus, mockAskUseCase } = makeService('ask');

            // Mock use case emits tokens through the shared EventBus
            mockAskUseCase.execute.mockImplementation(async () => {
                eventBus.emit('stream_token', { token: 'Hello' });
                eventBus.emit('stream_token', { token: ' world' });
                return { content: 'Hello world', usage: ZERO_USAGE };
            });

            await service.initialize();
            await service.executeInstruction('explain this code');

            const tokenEvents = events.filter(e => e.type === 'stream_token');
            expect(tokenEvents.length).toBe(2);
        });

        it('emits turn_saved after successful ask', async () => {
            const { service, events } = makeService('ask');
            await service.initialize();

            await service.executeInstruction('simple question?');

            const saved = events.find(e => e.type === 'turn_saved');
            expect(saved).toBeDefined();
        });

        it('emits error event when askUseCase throws', async () => {
            const { service, events, mockAskUseCase } = makeService('ask');
            mockAskUseCase.execute.mockRejectedValue(new Error('API down'));

            await service.initialize();
            await service.executeInstruction('explain something');

            const errorEvent = events.find(e => e.type === 'error');
            expect(errorEvent?.data.message).toContain('API down');
        });
    });

    describe('executeInstruction() — intent classification fallback', () => {
        it('emits status_update warning when intent classification fails', async () => {
            // The real IntentRouter catches LLM errors, emits a warning via the
            // EventBus, and falls back to 'edit'.  Simulate that same contract here
            // so the controller unit test remains independent of IntentRouter internals.
            const { service, events, eventBus, mockIntentRouter } = makeService();
            mockIntentRouter.classify.mockImplementation(async () => {
                eventBus.emit('status_update', { warning: 'Intent classification failed: timeout' });
                return 'edit';
            });

            await service.initialize();
            await service.executeInstruction('fix the bug');

            const warning = events.find(
                e => e.type === 'status_update' && String(e.data.warning ?? '').includes('Intent classification failed'),
            );
            expect(warning).toBeDefined();
        });
    });

    describe('executeInstruction() — tutor null guard', () => {
        it('emits error when tutorUseCase is null and mode is non-default', async () => {
            const events: AgentEvent[] = [];
            const eventBus = new EventBus();
            const repo = makeMockRepo();

            const deps: AgentServiceDeps = {
                askUseCase:         { execute: vi.fn() } as never,
                instructionUseCase: { execute: vi.fn() } as never,
                runUseCase:         { execute: vi.fn() } as never,
                tutorUseCase:       null,
                installUseCase:     { execute: vi.fn() } as never,
                intentRouter:       { classify: vi.fn() } as never,
                summarizer: {
                    shouldSummarize: vi.fn().mockReturnValue(false),
                    summarize: vi.fn().mockResolvedValue([]),
                } as never,
                pluginLoader:  { loadAll: async () => [] },
                modeManager:   new ModeManager('tutor-guide'),
                repo,
                initialModel:  'claude-test',
                eventBus,
            };

            const service = new AgentService(
                { directory: '/fake/project' },
                (event) => events.push(event),
                deps,
            );
            await service.initialize();
            await service.executeInstruction('help me');

            const err = events.find(e => e.type === 'error');
            expect(err?.data.message).toMatch(/backend not configured/i);
        });
    });

    describe('executeInstruction() — tutor session_turns switchover (Option C §5.3/§7)', () => {
        function makeTutorService() {
            const events: AgentEvent[] = [];
            const eventBus = new EventBus();
            const repo = makeMockRepo();
            const mockTutorUseCase = {
                execute: vi.fn().mockResolvedValue({ content: 'tutor response', usage: ZERO_USAGE, apiLogs: [] }),
            };
            const summarizer = {
                shouldSummarize: vi.fn().mockReturnValue(true), // even if it WOULD fire, tutor path must skip it
                summarize: vi.fn().mockResolvedValue([]),
            };
            const deps: AgentServiceDeps = {
                askUseCase:         { execute: vi.fn() } as never,
                instructionUseCase: { execute: vi.fn() } as never,
                runUseCase:         { execute: vi.fn() } as never,
                tutorUseCase:       mockTutorUseCase as never,
                installUseCase:     { execute: vi.fn() } as never,
                intentRouter:       { classify: vi.fn() } as never,
                summarizer:         summarizer as never,
                pluginLoader:  { loadAll: async () => [] },
                modeManager:   new ModeManager('tutor-guide'),
                repo,
                initialModel:  'claude-test',
                eventBus,
            };
            const service = new AgentService({ directory: '/fake/project' }, (e) => events.push(e), deps);
            return { service, mockTutorUseCase, summarizer };
        }

        it('forwards session_turns built from prior turns and bypasses the frontend summarizer', async () => {
            const { service, mockTutorUseCase, summarizer } = makeTutorService();
            await service.initialize();
            // Seed a prior turn so session_turns is non-empty.
            service.getSession().addTurn('earlier question', 'earlier hint', ZERO_USAGE);

            await service.executeInstruction('next question');

            expect(mockTutorUseCase.execute).toHaveBeenCalledTimes(1);
            const [instruction, history, sessionTurns] = mockTutorUseCase.execute.mock.calls[0];
            expect(instruction).toBe('next question');
            expect(history).toEqual([
                { role: 'user', content: 'earlier question' },
                { role: 'assistant', content: 'earlier hint' },
            ]);
            expect(sessionTurns).toEqual([{ prompt: 'earlier question', prose: 'earlier hint' }]);
            // §5.3: the backend owns the rolling summary now — the frontend must not summarize.
            expect(summarizer.summarize).not.toHaveBeenCalled();
        });
    });

    describe('handleSlashCommand()', () => {
        it('/status returns session info string', async () => {
            const { service } = makeService();
            await service.initialize();

            const result = await service.handleSlashCommand('/status');

            expect(result).toContain('Session:');
            expect(result).toContain('Context:');
        });

        it('/new creates a new session', async () => {
            const { service } = makeService();
            await service.initialize();
            const oldId = service.getSession().id;

            await service.handleSlashCommand('/new');

            expect(service.getSession().id).not.toBe(oldId);
        });

        it('/help returns available commands list', async () => {
            const { service } = makeService();
            await service.initialize();

            const result = await service.handleSlashCommand('/help');

            expect(result).toContain('/status');
            expect(result).toContain('/rollback');
            expect(result).toContain('/exit');
        });

        it('/unknown returns unknown command message', async () => {
            const { service } = makeService();
            await service.initialize();

            const result = await service.handleSlashCommand('/xyz');

            expect(result).toContain('Unknown command');
        });

        it('/rollback handles invalid index gracefully', async () => {
            const { service } = makeService();
            await service.initialize();

            const result = await service.handleSlashCommand('/rollback 99');

            expect(result).toContain('Rollback failed');
        });
    });
});
