/**
 * Use Case: ExecuteInstructionUseCase
 *
 * Handles the edit / orchestration pipeline: runs the ReAct loop, validates
 * LLM-proposed file edits, applies them with user approval.
 *
 * Returns InstructionResult — the caller is responsible for persisting the
 * session turn.
 */

import { LLMGateway } from '../../domain/types/llm-gateway';
import { IFileSystem } from '../../domain/types/file-system';
import { LocalFileSystem } from '../../infrastructure/filesystem/local-file-system';
import { LLMRequestPayload } from '../../shared/types/llm-types';
import { TurnUsage } from '../../domain/entities/conversation-turn';
import { ToolRegistry } from '../orchestration/tool-registry';
import { DiffEngine } from '../services/diff-engine';
import { SessionMessage } from '../../shared/types/messages';
import { Orchestrator, OrchestratorResult } from '../orchestration/orchestrator';
import { LLMOutput } from '../../domain/values/llm-output';
import { Evaluator } from '../services/evaluator';
import { buildInstructionAgentPrompt } from '../prompts/instruction-agent';
import { KnowledgeBase } from '../services/knowledge-base';
import { IKnowledgeRepository } from '../../domain/interfaces/i-knowledge-repository';
import { EditStagingService, StagedEdit } from '../services/edit-staging-service';
import { DiffLine } from '../services/diff-engine';

type EmitFn = (type: string, data: Record<string, unknown>) => void;

export interface ExecuteInstructionDeps {
    llm: LLMGateway;
    registry: ToolRegistry;
    diffEngine: DiffEngine;
    directory: string;
    /** Human-in-the-loop callback: returns true to apply the edit, false to skip. */
    onApproval: (edit: { path: string; diff: string; diffLines: DiffLine[]; original: string; proposed: string }) => Promise<boolean>;
    emit: EmitFn;
    /** Injected repository used to load the knowledge base at startup. */
    knowledgeRepo?: IKnowledgeRepository;
    /** Pre-built KnowledgeBase — takes priority over knowledgeRepo (for tests). */
    knowledgeBase?: KnowledgeBase;
    /** Optional — defaults to new Evaluator(). */
    evaluator?: Evaluator;
    /** Optional — defaults to new Orchestrator(llm, registry). */
    orchestrator?: Orchestrator;
    /** Optional — defaults to new EditStagingService(fileSystem, diffEngine). */
    stagingService?: EditStagingService;
    /** Optional — defaults to LocalFileSystem. Must be provided explicitly in tests. */
    fileSystem?: IFileSystem;
}

export interface InstructionResult {
    appliedFiles: string[];
    outputs: LLMOutput[];
    validatedEdits: Array<{ path: string; content: string }>;
    usage: TurnUsage;
    /** Set when orchestration produced no edit artifacts (analysis-only response). */
    analysisSummary?: string;
}

// ── ExecuteInstructionUseCase ─────────────────────────────────────────────────

export class ExecuteInstructionUseCase {
    private readonly knowledgeBase: KnowledgeBase;
    private readonly evaluator: Evaluator;
    private readonly orchestrator: Orchestrator;
    private readonly stagingService: EditStagingService;

    constructor(private readonly deps: ExecuteInstructionDeps) {
        if (deps.knowledgeBase) {
            this.knowledgeBase = deps.knowledgeBase;
        } else {
            this.knowledgeBase = new KnowledgeBase();
            if (deps.knowledgeRepo) this.knowledgeBase.load(deps.knowledgeRepo.load());
        }
        this.evaluator = deps.evaluator ?? new Evaluator();
        this.orchestrator = deps.orchestrator ?? new Orchestrator(deps.llm, deps.registry);
        const fileSystem = deps.fileSystem ?? new LocalFileSystem();
        this.stagingService = deps.stagingService ?? new EditStagingService(fileSystem, deps.diffEngine);
    }

    async execute(instruction: string, history: SessionMessage[]): Promise<InstructionResult> {
        let orchResult: OrchestratorResult;
        let baseRequest: LLMRequestPayload;
        try {
            ({ orchResult, baseRequest } = await this.runOrchestration(instruction, history));
        } catch {
            throw new Error('Orchestration failed'); // error already emitted by runOrchestration
        }

        const { validatedEdits, outputs } = await this.validateArtifacts(orchResult, baseRequest);

        // Collect edits from two sources:
        //   1. ReAct tool calls  → already staged inside EditStagingService with original + diff pre-computed
        //   2. LLM artifact JSON → converted to StagedEdit here (read original, compute diff)
        const toolStagedEdits = this.stagingService.drainStagedEdits();
        const artifactEdits = this.stagingService.stageFromArtifacts(validatedEdits, this.deps.directory, this.deps.emit);
        const allEdits = [...toolStagedEdits, ...artifactEdits];

        if (allEdits.length === 0) {
            const analysisSummary = outputs.map(o => o.content).join('\n') || 'No changes generated.';
            return {
                appliedFiles: [],
                outputs,
                validatedEdits,
                usage: orchResult.usage,
                analysisSummary,
            };
        }

        const appliedFiles = await this.applyEditsWithApproval(allEdits);
        return { appliedFiles, outputs, validatedEdits, usage: orchResult.usage };
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async runOrchestration(
        instruction: string,
        history: SessionMessage[],
    ): Promise<{ orchResult: OrchestratorResult; baseRequest: LLMRequestPayload }> {
        this.deps.emit('phase_start', { phase: 'orchestrator', description: 'Running agent (ReAct loop)' });

        const knowledgeEntries = this.knowledgeBase.retrieve(instruction, 3, this.deps.directory);

        const orchestrator = this.orchestrator;

        const toolsText = this.buildToolsText();

        let knowledgeText: string | undefined;
        if (knowledgeEntries.length > 0) {
            knowledgeText = knowledgeEntries.map(entry => `### ${entry.title}\n${entry.content}`).join('\n\n');
            this.deps.emit('status_update', { knowledge: knowledgeEntries.map(entry => entry.title) });
        }

        const systemPrompt = buildInstructionAgentPrompt(this.deps.directory, toolsText, knowledgeText);

        const baseRequest: LLMRequestPayload = {
            systemPrompt,
            userMessage: instruction,
            history,
            model: undefined,
        };

        try {
            const orchResult = await orchestrator.run(baseRequest, instruction);
            this.deps.emit('phase_end', {
                phase: 'orchestrator',
                success: true,
                summary: `${orchResult.subTasksRun} sub-task(s), ${orchResult.steps.length} step(s)`,
            });

            for (const step of orchResult.steps) {
                this.deps.emit('react_step', {
                    stepNumber: step.stepNumber,
                    thought: step.thought,
                    action: step.action,
                    observation: step.observation,
                });
                if (step.action && step.toolResultData !== undefined) {
                    this.emitToolResult(step.action.tool, step.toolResultData);
                }
            }

            return { orchResult, baseRequest };
        } catch (error) {
            this.deps.emit('phase_end', { phase: 'orchestrator', success: false });
            this.deps.emit('error', {
                message: error instanceof Error ? error.message : String(error),
                phase: 'orchestrator',
            });
            throw error;
        }
    }

    private async validateArtifacts(
        orchResult: OrchestratorResult,
        baseRequest: LLMRequestPayload,
    ): Promise<{
        validatedEdits: Array<{ path: string; content: string }>;
        outputs: LLMOutput[];
    }> {
        const evaluator = this.evaluator;

        for (const output of orchResult.outputs) {
            this.deps.emit('text_output', { content: output.content });
        }

        const validatedEdits: Array<{ path: string; content: string }> = [];
        for (const fc of orchResult.fileChanges) {
            const validation = evaluator.validateEditOutput(fc.content);
            if (validation.valid && validation.artifacts) {
                validatedEdits.push(...validation.artifacts);
            } else {
                const corrected = await evaluator.retryWithCorrection(this.deps.llm, baseRequest, fc.content);
                const retryValidation = evaluator.validateEditOutput(corrected);
                if (retryValidation.valid && retryValidation.artifacts) {
                    validatedEdits.push(...retryValidation.artifacts);
                } else {
                    validatedEdits.push({ path: fc.path, content: fc.content });
                }
            }
        }

        return { validatedEdits, outputs: orchResult.outputs };
    }

    /**
     * Present each staged edit to the user for approval and apply approved ones via EditStagingService.
     * No direct fs calls here — all I/O is delegated to stagingService.applyEdit().
     */
    private async applyEditsWithApproval(edits: StagedEdit[]): Promise<string[]> {
        this.deps.emit('phase_start', { phase: 'review', description: 'Review proposed changes' });
        const appliedFiles: string[] = [];

        for (const edit of edits) {
            this.deps.emit('diff_proposed', {
                path: edit.path,
                diff: edit.diff,
                diffLines: edit.diffLines,
                original: edit.original,
                proposed: edit.content,
            });

            const approved = await this.deps.onApproval({
                path: edit.path,
                diff: edit.diff,
                diffLines: edit.diffLines,
                original: edit.original,
                proposed: edit.content,
            });

            if (approved) {
                this.stagingService.applyEdit(edit);
                this.deps.emit('edit_applied', { path: edit.path });
                appliedFiles.push(edit.path);
            } else {
                this.deps.emit('edit_rejected', { path: edit.path });
            }
        }

        this.deps.emit('phase_end', { phase: 'review', success: true });
        return appliedFiles;
    }

    private emitToolResult(toolName: string, data: unknown): void {
        const eventMap: Record<string, string> = {
            file_scan:    'tool_result_scan',
            library_scan: 'tool_result_library',
            r_exec:       'tool_result_r_exec',
            r_install:    'tool_result_r_install',
        };
        const eventType = eventMap[toolName];
        if (eventType) {
            this.deps.emit(eventType, { data });
        }
    }

    /** Format all registered tool schemas into the plain-text list injected into the system prompt. */
    private buildToolsText(): string {
        return this.deps.registry.getSchemas().map(schema => {
            const params = Object.entries(schema.parameters)
                .map(([k, v]) => `    - ${k} (${v.type}${v.required ? ', required' : ''}): ${v.description}`)
                .join('\n');
            return `- ${schema.name}: ${schema.description}\n  Parameters:\n${params}` +
                (schema.example ? `\n  Example: ${schema.example}` : '');
        }).join('\n\n');
    }
}
