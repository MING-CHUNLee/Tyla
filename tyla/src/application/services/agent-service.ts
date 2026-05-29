/**
 * Service: AgentService
 *
 * Thin coordinator that manages session lifecycle, routes instructions to the
 * appropriate Use Case, and persists turns.  All I/O is event-driven — no
 * console.log, no readline, no ora.
 *
 * The CLI adapter (or any other UI) subscribes to events and provides an
 * approval callback for the human-in-the-loop safety gate.
 *
 * All use cases, services, and infrastructure objects are injected fully
 * assembled via AgentServiceDeps (built by agent-factory.ts).
 * The service's only reason to change: the business workflow signature.
 */

import { SessionStore } from '../../domain/repositories/session-store';
import { ConversationSession } from '../../domain/entities/conversation-session';
import { TurnUsage } from '../../domain/entities/conversation-turn';

import { HistorySummarizer } from '../services/history-summarizer';
import { IntentRouter, Intent } from '../services/intent-router';
import { ModeManager, WorkflowMode } from '../services/mode-manager';
import { SlashCommandRouter } from '../services/slash-command-router';
import type { RBridgePort } from '../ports/r-bridge-port';
import { EventBus } from '../services/event-bus';

import { FileChange } from '../../domain/entities/file-change';
import { SessionMessage } from '../../shared/types/messages';

import { ExecuteAskUseCase } from '../use-cases/execute-ask-use-case';
import { ExecuteInstructionUseCase } from '../use-cases/execute-instruction-use-case';
import { ExecuteRunUseCase } from '../use-cases/execute-run-use-case';
import { ExecuteTutorUseCase } from '../use-cases/execute-tutor-use-case';
import { ExecuteInstallUseCase } from '../use-cases/execute-install-use-case';

// ── Event Types (discriminated union) ────────────────────────────────────────

/** Each variant carries exactly the data that event type needs. */
export type AgentEvent =
    | { type: 'session_loaded';    data: { sessionId: string; turnCount: number; model: string } }
    | { type: 'intent_classified'; data: { intent: string } }
    | { type: 'phase_start';       data: { phase: string; description: string } }
    | { type: 'phase_end';         data: { phase: string; success: boolean; summary?: string } }
    | { type: 'react_step';        data: { stepNumber: number; thought?: string; action?: { tool: string }; observation?: string } }
    | { type: 'text_output';       data: { content: string } }
    | { type: 'stream_token';      data: { token: string } }
    | { type: 'diff_proposed';     data: { path: string; diff: string; original: string; proposed: string } }
    | { type: 'edit_applied';      data: { path: string } }
    | { type: 'edit_rejected';     data: { path: string } }
    | { type: 'turn_saved';        data: {
        turnCount:           number;
        sessionId:           string;
        model:               string;
        usagePercent:        number;
        health:              string;
        totalCostUSD:        number;
        lastInputTokens:     number;
        lastOutputTokens:    number;
        lastResponseTimeMs?: number;
    } }
    | { type: 'error';             data: { message: string; phase?: string } }
    | { type: 'status_update';     data: { plugins?: string[]; warning?: string; knowledge?: string[] } }
    | { type: 'tool_result_scan';     data: { data: unknown } }
    | { type: 'tool_result_library';  data: { data: unknown } }
    | { type: 'tool_result_r_exec';   data: { data: unknown } }
    | { type: 'tool_result_r_install'; data: { data: unknown } }
    | { type: 'guard_blocked';    data: { reason: string; phase: string } }
    | { type: 'install_proposed'; data: {
        toInstall: string[];
        alreadyInstalled: string[];
        blocked: Array<{ name: string; reason: string }>;
        warnings: Array<{ name: string; message: string }>;
    } };

/** Convenience alias for the union of all valid event type strings. */
export type AgentEventType = AgentEvent['type'];

export interface ProposedEdit {
    path: string;
    diff: string;
    original: string;
    proposed: string;
}

export interface ProposedInstall {
    toInstall: string[];
    alreadyInstalled: string[];
    blocked: Array<{ name: string; reason: string }>;
    warnings: Array<{ name: string; message: string }>;
}

export type ApprovalCallback = (edit: ProposedEdit) => Promise<boolean>;
export type InstallApprovalCallback = (plan: ProposedInstall) => Promise<boolean>;
export type EventCallback = (event: AgentEvent) => void;

export interface AgentServiceOptions {
    directory?: string;
    sessionId?: string;
    forceNew?: boolean;
}

/** Application-layer abstraction for plugin loading. */
export interface IPluginLoader {
    loadAll(): Promise<Array<{ name: string; loaded: boolean }>>;
}

/**
 * Injectable dependencies — all required; use agent-factory.ts to build defaults.
 *
 * Contains only application-layer types (use cases, services, value objects).
 * Raw infrastructure types (LLMGateway, DiffEngine, ToolRegistry) are absent:
 * they are wired inside agent-factory.ts and never leak into this layer.
 */
export interface AgentServiceDeps {
    // ── Assembled use cases ───────────────────────────────────────────────────
    askUseCase: ExecuteAskUseCase;
    instructionUseCase: ExecuteInstructionUseCase;
    runUseCase: ExecuteRunUseCase;
    tutorUseCase: ExecuteTutorUseCase;
    installUseCase: ExecuteInstallUseCase;
    // ── Application services ──────────────────────────────────────────────────
    intentRouter: IntentRouter;
    summarizer: HistorySummarizer;
    pluginLoader: IPluginLoader;
    modeManager: ModeManager;
    // ── Session / identity ────────────────────────────────────────────────────
    /** Still needed: initialize() loads/saves sessions. */
    repo: SessionStore;
    /** Plain model name — replaces the former llm.getProviderInfo() call. */
    initialModel: string;
    /** Optional RStudio listener bridge (used by slash commands and run routing). */
    rBridge?: RBridgePort;
    // ── Late-binding event bus ────────────────────────────────────────────────
    /** Bound to the viewAdapter in the constructor. */
    eventBus: EventBus;
}

// ── AgentService ──────────────────────────────────────────────────────────────

export class AgentService {
    private _session?: ConversationSession;
    private previousSessionSummary = '';
    private readonly repo: SessionStore;
    private readonly initialModel: string;
    private readonly viewAdapter: EventCallback;

    private readonly summarizer: HistorySummarizer;
    private readonly pluginLoader: IPluginLoader;
    private readonly intentRouter: IntentRouter;
    private readonly askUseCase: ExecuteAskUseCase;
    private readonly instructionUseCase: ExecuteInstructionUseCase;
    private readonly runUseCase: ExecuteRunUseCase;
    private readonly tutorUseCase: ExecuteTutorUseCase;
    private readonly installUseCase: ExecuteInstallUseCase;
    private readonly modeManager: ModeManager;
    private readonly slashRouter: SlashCommandRouter;

    /** Throws if initialize() has not been called yet. */
    private get session(): ConversationSession {
        if (!this._session) throw new Error('AgentService not initialized — call initialize() first');
        return this._session;
    }

    constructor(
        _options: AgentServiceOptions,
        viewAdapter: EventCallback,
        deps: AgentServiceDeps,
    ) {
        this.viewAdapter  = viewAdapter;
        this.repo         = deps.repo;
        this.initialModel = deps.initialModel;

        // Bind the EventBus to the view adapter so all use-case emit() calls
        // flow to the presentation layer without the service holding raw infra.
        deps.eventBus.bind((type, data) => {
            this.viewAdapter({ type, data } as AgentEvent);
        });

        this.summarizer   = deps.summarizer;
        this.pluginLoader = deps.pluginLoader;
        this.intentRouter = deps.intentRouter;

        this.askUseCase         = deps.askUseCase;
        this.instructionUseCase = deps.instructionUseCase;
        this.runUseCase         = deps.runUseCase;
        this.tutorUseCase       = deps.tutorUseCase;
        this.installUseCase     = deps.installUseCase;

        this.modeManager = deps.modeManager;

        // SlashCommandRouter is constructed here because its context captures
        // the service's session-management callbacks (setSession, etc.).
        const self = this;
        this.slashRouter = new SlashCommandRouter({
            get session() { return self.session; },
            repo: this.repo,
            modeManager: this.modeManager,
            rBridge: deps.rBridge,
            initialModel: this.initialModel,
            setSession: (s) => { this._session = s; },
            setPreviousSummary: (s) => { this.previousSessionSummary = s; },
        });
    }

    /** Initialize: load/create session, load plugins */
    async initialize(options?: { sessionId?: string; forceNew?: boolean }): Promise<void> {
        const model = this.initialModel;

        if (options?.sessionId) {
            this._session = (await this.repo.load(options.sessionId)) ?? ConversationSession.create(model);
        } else if (!options?.forceNew) {
            const last = await this.repo.loadLast();
            this._session = last ?? ConversationSession.create(model);
        } else {
            // forceNew: load the last session's summary for cross-session context
            const prev = await this.repo.loadLast();
            if (prev) this.previousSessionSummary = SlashCommandRouter.formatSessionSummary(prev);
            this._session = ConversationSession.create(model);
        }

        this.emit({ type: 'session_loaded', data: {
            sessionId: this.session.id,
            turnCount: this.session.turnCount,
            model: this.session.model,
        } });

        try {
            const pluginMetas = await this.pluginLoader.loadAll();
            const loadedPlugins = pluginMetas.filter(meta => meta.loaded).map(meta => meta.name);
            if (loadedPlugins.length > 0) {
                this.emit({ type: 'status_update', data: { plugins: loadedPlugins } });
            }
        } catch (error) {
            this.emit({ type: 'status_update', data: {
                warning: `Plugin loading failed: ${error instanceof Error ? error.message : String(error)}`,
            } });
        }
    }

    /** Get current session */
    getSession(): ConversationSession {
        return this.session;
    }

    /** Get the currently active workflow mode */
    getMode(): WorkflowMode {
        return this.modeManager.getMode();
    }

    /** Execute a question through the ask pipeline (skips intent classification) */
    async executeAsk(instruction: string): Promise<void> {
        const history = await this.prepareHistory();
        return this.executeWithMode(
            instruction,
            () => this.askUseCase.execute(instruction, history, this.previousSessionSummary),
            result => result.content,
        );
    }

    /** Execute one instruction through the full agent pipeline */
    async executeInstruction(instruction: string): Promise<void> {
        const history = await this.prepareHistory();

        // Non-default modes bypass intent classification and go directly to the tutor pipeline,
        // which reads the corresponding policy md file for the active mode.
        const mode = this.modeManager.getMode();
        if (mode !== 'default') {
            return this.executeWithMode(
                instruction,
                () => this.tutorUseCase.execute(instruction, history),
                result => result.content,
            );
        }

        const intent = await this.classifyIntent(instruction, history);

        if (intent === 'ask') {
            return this.executeWithMode(
                instruction,
                () => this.askUseCase.execute(instruction, history, this.previousSessionSummary),
                result => result.content,
            );
        }

        if (intent === 'run') {
            return this.executeWithMode(
                instruction,
                () => this.runUseCase.execute(instruction, history),
                result => result.analysis,
            );
        }

        if (intent === 'install') {
            return this.executeWithMode(
                instruction,
                () => this.installUseCase.execute(instruction),
                result => result.content,
            );
        }

        let result;
        try {
            result = await this.instructionUseCase.execute(instruction, history);
        } catch (error) {
            this.emit({ type: 'error', data: {
                message: error instanceof Error ? error.message : String(error),
            } });
            return;
        }

        if (result.analysisSummary !== undefined) {
            // Orchestration produced no edit artifacts — save as analysis turn
            this.session.addTurn(instruction, result.analysisSummary, result.usage, [], result.outputs);
        } else {
            const assistantSummary = result.appliedFiles.length > 0
                ? `Applied changes to: ${result.appliedFiles.join(', ')}.`
                : 'No changes were applied.';

            const fileChanges = result.appliedFiles
                .map(filePath => {
                    const edit = result.validatedEdits.find(e => e.path === filePath);
                    return edit ? FileChange.create('edit', filePath, edit.content) : null;
                })
                .filter((fc): fc is FileChange => fc !== null);

            this.session.addTurn(instruction, assistantSummary, result.usage, fileChanges, result.outputs);
        }

        await this.repo.save(this.session);
        this.emitTurnSaved(result.usage);
    }

    /**
     * Generic helper that executes a use case, persists the turn, and emits
     * turn_saved — or emits an error event if the use case throws unexpectedly.
     */
    private async executeWithMode<T extends { usage: TurnUsage }>(
        instruction: string,
        execute: () => Promise<T>,
        toTurnContent: (result: T) => string,
    ): Promise<void> {
        try {
            const result = await execute();
            this.session.addTurn(instruction, toTurnContent(result), result.usage);
            await this.repo.save(this.session);
            this.emitTurnSaved(result.usage);
        } catch (error) {
            this.emit({ type: 'error', data: {
                message: error instanceof Error ? error.message : String(error),
            } });
        }
    }

    /** Handle slash commands — delegates to SlashCommandRouter */
    async handleSlashCommand(command: string): Promise<string> {
        return this.slashRouter.handle(command);
    }

    // ── Private utilities ─────────────────────────────────────────────────────

    private async prepareHistory(): Promise<SessionMessage[]> {
        return this.summarizer.shouldSummarize(this.session)
            ? await this.summarizer.summarize(this.session)
            : this.session.getHistory().map(msg => ({ role: msg.role as 'user' | 'assistant', content: msg.content }));
    }

    private async classifyIntent(instruction: string, history: SessionMessage[]): Promise<Intent> {
        return this.intentRouter.classify(instruction, history);
    }

    private emit(event: AgentEvent): void {
        this.viewAdapter(event);
    }

    private emitTurnSaved(usage: TurnUsage): void {
        const budget = this.session.tokenBudget;
        this.emit({ type: 'turn_saved', data: {
            turnCount:          this.session.turnCount,
            sessionId:          this.session.id,
            model:              this.session.model,
            usagePercent:       budget.usagePercent,
            health:             budget.health,
            totalCostUSD:       this.session.totalCostUSD,
            lastInputTokens:    usage.inputTokens,
            lastOutputTokens:   usage.outputTokens,
            lastResponseTimeMs: usage.responseTimeMs,
        } });
    }

}

