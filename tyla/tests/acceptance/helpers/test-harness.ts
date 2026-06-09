/**
 * Test Harness
 *
 * Constructs a real AgentController wired with a RecordReplayLLM and a real
 * (but no-op) SessionRepository.  All events are collected into an array
 * so tests can assert on the full event stream.
 *
 * IMPORTANT: call process.chdir(workspace.root) BEFORE createHarness() so that
 * SessionRepository (which reads process.cwd()) writes sessions to the temp dir.
 */

import { AgentService } from '../../../src/application/services/agent-service';
import type { AgentEvent, AgentServiceDeps as AgentControllerDeps, ApprovalCallback } from '../../../src/application/services/agent-service';
import { DiffEngine } from '../../../src/application/services/diff-engine';
import { ToolRegistry } from '../../../src/application/orchestration/tool-registry';
import { EditStagingService } from '../../../src/application/services/edit-staging-service';
import { FileReadService } from '../../../src/application/services/file-read-service';
import { HistorySummarizer } from '../../../src/application/services/history-summarizer';
import { ModeManager } from '../../../src/application/services/mode-manager';
import { IntentRouter } from '../../../src/application/services/intent-router';
import { EventBus } from '../../../src/application/services/event-bus';
import { LocalFileSystem } from '../../../src/infrastructure/filesystem/local-file-system';
import { DirectoryScanner } from '../../../src/infrastructure/filesystem/directory-scanner';
import { RScriptRunner } from '../../../src/infrastructure/r-adapter/r-script-runner';
import { FileScanTool } from '../../../src/application/tools/file-scan-tool';
import { FileReadTool } from '../../../src/application/tools/file-read-tool';
import { FileEditTool } from '../../../src/application/tools/file-edit-tool';
import { RExecTool } from '../../../src/application/tools/r-exec-tool';
import { RInstallTool } from '../../../src/application/tools/r-install-tool';
import { ExecuteAskUseCase } from '../../../src/application/use-cases/execute-ask-use-case';
import { ExecuteInstructionUseCase } from '../../../src/application/use-cases/execute-instruction-use-case';
import { ExecuteRunUseCase } from '../../../src/application/use-cases/execute-run-use-case';
import { ExecuteInstallUseCase } from '../../../src/application/use-cases/execute-install-use-case';
import type { LLMGateway } from '../../../src/domain/types/llm-gateway';
import type { SessionRepository } from '../../../src/infrastructure/persistence/session-repository';
import type { RecordReplayLLM } from './record-replay-llm';
import type { TestWorkspace } from './test-workspace';

/**
 * No-op SessionRepository stub.
 * Avoids writing sessions to the real .mindy/ directory during tests.
 */
const noopRepo = {
    save: async () => {},
    load: async () => null,
    loadLast: async () => null,
    list: async () => [],
    delete: async () => {},
} as unknown as SessionRepository;

export interface HarnessOpts {
    workspace: TestWorkspace;
    llm: RecordReplayLLM;
    /** Default: auto-approve every edit. */
    onApproval?: ApprovalCallback;
}

export interface Harness {
    service: AgentService;
    events: AgentEvent[];
    /** Convenience: events of a given type */
    eventsOf<T extends AgentEvent['type']>(type: T): Extract<AgentEvent, { type: T }>[];
}

export function createHarness(opts: HarnessOpts): Harness {
    const events: AgentEvent[] = [];
    const onApproval: ApprovalCallback = opts.onApproval ?? (() => Promise.resolve(true));
    const directory = opts.workspace.root;

    // Cast: RecordReplayLLM satisfies the three methods used at runtime
    const llm = opts.llm as unknown as LLMGateway;

    // ── Infrastructure ────────────────────────────────────────────────────────
    const diffEngine = new DiffEngine();
    const fs         = new LocalFileSystem();
    const registry   = new ToolRegistry();

    const stagingService  = new EditStagingService(fs, diffEngine);
    const fileReadService = new FileReadService(fs, directory);
    const rRunner         = new RScriptRunner();

    registry.register(new FileScanTool(new DirectoryScanner()));
    registry.register(new FileReadTool(fileReadService));
    registry.register(new FileEditTool(stagingService));
    registry.register(new RExecTool(rRunner));
    registry.register(new RInstallTool());

    // ── Buses + services ──────────────────────────────────────────────────────
    const eventBus     = new EventBus();
    const emit         = eventBus.emit.bind(eventBus);
    // No LLM injected — HistorySummarizer falls back to raw history (fine for tests).
    const summarizer   = new HistorySummarizer();
    // Explicit 'default' prevents getSettings() from loading 'tutor-socratic' and
    // routing executeInstruction() into the tutor path (which has no gateways here).
    const modeManager  = new ModeManager('default');
    const intentRouter = new IntentRouter(llm, emit);

    // ── Use cases ─────────────────────────────────────────────────────────────
    const askUseCase = new ExecuteAskUseCase({ llm, registry, directory, emit });

    const instructionUseCase = new ExecuteInstructionUseCase({
        llm, registry, diffEngine, directory, onApproval, stagingService, emit,
    });

    const runUseCase = new ExecuteRunUseCase({ llm, registry, directory, emit });

    // No profile configured in acceptance test harness → null (mirrors agent-factory behaviour).
    const tutorUseCase = null;
    const installUseCase = new ExecuteInstallUseCase({ registry, emit });

    // ── Assembled deps ────────────────────────────────────────────────────────
    const deps: AgentControllerDeps = {
        askUseCase,
        instructionUseCase,
        runUseCase,
        tutorUseCase,
        installUseCase,
        intentRouter,
        summarizer,
        pluginLoader: { loadAll: async () => [] },
        modeManager,
        repo: noopRepo,
        initialModel: 'test-model',
        eventBus,
    };

    const service = new AgentService(
        { directory },
        (event) => events.push(event),
        deps,
    );

    return {
        service,
        events,
        eventsOf<T extends AgentEvent['type']>(type: T) {
            return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
        },
    };
}
