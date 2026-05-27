/**
 * Composition Root: buildAgentDeps
 *
 * The single place where all infrastructure concretions and application use
 * cases are instantiated and wired together.  Callers (CLI adapter, TUI)
 * receive a fully assembled AgentServiceDeps object — no infrastructure
 * imports leak into presentation or application layers.
 *
 * Parameters
 *   directory         — resolved workspace path; passed to every use case
 *   onApproval        — file-edit approval gate (presentation-layer callback)
 *   onInstallApproval — R-package install approval gate (optional)
 */

import path from 'path';

import { LlmGateway } from '../api/llm/gateway/llm-gateway';
import { SessionRepository } from '../persistence/session-repository';
import { LocalFileSystem } from '../filesystem/local-file-system';
import { DirectoryScanner } from '../filesystem/directory-scanner';
import { RScriptRunner } from '../r-adapter/r-script-runner';
import { getRBridge } from '../r-adapter/r-bridge';
import { PluginLoader } from '../filesystem/plugin-loader';
import { KnowledgeRepository } from '../persistence/knowledge-repository';

import { PolicyLoader } from '../config/policy-loader';
import { DiffEngine } from '../../application/services/diff-engine';
import { ToolRegistry } from '../../application/orchestration/tool-registry';
import { EditStagingService } from '../../application/services/edit-staging-service';
import { FileReadService } from '../../application/services/file-read-service';
import { HistorySummarizer } from '../../application/services/history-summarizer';
import { ModeManager } from '../../application/services/mode-manager';
import { IntentRouter } from '../../application/services/intent-router';
import { EventBus, ApprovalBus, InstallApprovalBus } from '../../application/services/event-bus';

import { FileScanTool } from '../../application/tools/file-scan-tool';
import { FileReadTool } from '../../application/tools/file-read-tool';
import { FileEditTool } from '../../application/tools/file-edit-tool';
import { PdfReadTool } from '../../application/tools/pdf-read-tool';
import { RExecTool } from '../../application/tools/r-exec-tool';
import { RInstallTool } from '../../application/tools/r-install-tool';
import { RRenderTool } from '../../application/tools/r-render-tool';
import { LibraryScanTool } from '../../application/tools/library-scan-tool';

import { ExecuteAskUseCase } from '../../application/use-cases/execute-ask-use-case';
import { ExecuteInstructionUseCase } from '../../application/use-cases/execute-instruction-use-case';
import { ExecuteRunUseCase } from '../../application/use-cases/execute-run-use-case';
import { ExecuteTutorUseCase } from '../../application/use-cases/execute-tutor-use-case';
import { TutorChatGateway } from '../api/tutor/tutor-chat-gateway';
import { appendGuardLog } from '../persistence/guard-log-repository';
import { getProfile } from '../config/profile';
import { ExecuteInstallUseCase } from '../../application/use-cases/execute-install-use-case';

import type {
    AgentServiceDeps,
    ApprovalCallback,
    InstallApprovalCallback,
} from '../../application/services/agent-service';

export function buildAgentDeps(
    rawDirectory = '.',
    onApproval: ApprovalCallback = async () => false,
    onInstallApproval?: InstallApprovalCallback,
    assignmentDir?: string,
    tutorMode?: boolean,
): AgentServiceDeps {
    const directory = path.resolve(rawDirectory);

    // ── Infrastructure ────────────────────────────────────────────────────────
    const llm          = LlmGateway.fromEnv();
    const repo         = new SessionRepository();
    const diffEngine   = new DiffEngine();
    const fs           = new LocalFileSystem();
    const registry     = new ToolRegistry();
    const rBridge       = getRBridge();

    // stagingService is shared between FileEditTool (queues edits during ReAct)
    // and the instruction/solver use cases (drain the queue after the loop).
    const stagingService  = new EditStagingService(fs, diffEngine);
    const fileReadService = new FileReadService(fs);
    const rRunner         = new RScriptRunner();

    registry.register(new FileScanTool(new DirectoryScanner()));
    registry.register(new FileReadTool(fileReadService));
    registry.register(new FileEditTool(stagingService));
    registry.register(new PdfReadTool(fs));
    registry.register(new RExecTool(rRunner));
    registry.register(new RInstallTool());
    registry.register(new RRenderTool(fs, rRunner));
    registry.register(new LibraryScanTool());

    // ── Late-binding buses ────────────────────────────────────────────────────
    // These are bound to the presentation-layer callbacks in AgentController's
    // constructor via deps.eventBus.bind() / deps.approvalBus.bind() etc.
    const eventBus          = new EventBus();
    const approvalBus       = new ApprovalBus();
    const installApprovalBus = new InstallApprovalBus();

    // Bind approval gates immediately (they come from the presentation layer
    // and are available at factory call time).
    approvalBus.bind(onApproval);
    if (onInstallApproval) installApprovalBus.bind(onInstallApproval);

    const emit = eventBus.emit.bind(eventBus);

    // ── Application services ──────────────────────────────────────────────────
    const summarizer   = new HistorySummarizer(llm);
    const initialMode = assignmentDir ? 'tutor-guide' : tutorMode ? 'tutor-socratic' : undefined;
    const modeManager  = new ModeManager(initialMode);
    const intentRouter = new IntentRouter(llm, emit);

    // Pre-bound plugin loader — hides ToolRegistry from the controller.
    const pluginLoaderInfra = new PluginLoader();
    const pluginLoader = {
        loadAll: () => pluginLoaderInfra.loadAll(registry),
    };

    // ── Use cases ─────────────────────────────────────────────────────────────
    const askUseCase = new ExecuteAskUseCase({
        llm, registry, directory, emit,
    });

    const instructionUseCase = new ExecuteInstructionUseCase({
        llm,
        registry,
        diffEngine,
        directory,
        onApproval: approvalBus.approve.bind(approvalBus),
        stagingService,
        emit,
        knowledgeRepo: new KnowledgeRepository(),
    });

    const runUseCase = new ExecuteRunUseCase({
        llm, registry, directory, emit, rBridge,
    });

    const assignmentPolicyLoader = assignmentDir
        ? new PolicyLoader(undefined, assignmentDir)
        : undefined;

    const tutorChatGateway = getProfile(directory)
        ? new TutorChatGateway((msg) => emit('status_update', { warning: msg }), directory)
        : undefined;

    const tutorUseCase = new ExecuteTutorUseCase(
        { llm, registry, directory, emit, policyLoader: assignmentPolicyLoader, tutorChatGateway },
        modeManager.getMode(),
    );

    const installUseCase = new ExecuteInstallUseCase({
        registry,
        emit,
        onApproval: installApprovalBus.getCallback.bind(installApprovalBus)(),
    });

    // ── Assembled deps ────────────────────────────────────────────────────────
    return {
        askUseCase,
        instructionUseCase,
        runUseCase,
        tutorUseCase,
        installUseCase,
        intentRouter,
        summarizer,
        pluginLoader,
        modeManager,
        repo,
        rBridge,
        initialModel: llm.getProviderInfo().model,
        eventBus,
    };
}
