/**
 * Use Case: ExecuteTutorUseCase
 *
 * Tutor workflow mode pipeline (no file writes):
 *   1. Scan workspace for context
 *   2. Read relevant files
 *   3. Stream LLM response using the tutor system prompt
 *
 * Returns TutorResult — the caller is responsible for persisting the turn.
 */

import path from 'path';
import { LLMGateway } from '../../domain/types/llm-gateway';
import { TurnUsage } from '../../domain/entities/conversation-turn';
import { ToolRegistry } from '../orchestration/tool-registry';
import { SessionMessage } from '../../shared/types/messages';
import { estimateTokens } from '../prompts';
import { buildTutorModePrompt } from '../prompts/mode-agent';
import { PolicyLoader } from '../../infrastructure/config/policy-loader';
import { WorkflowMode } from '../../infrastructure/config/settings';
import { IGuardAgent } from '../../domain/types/guard-agent';
import { TutorChatGateway } from '../../infrastructure/api/tutor/tutor-chat-gateway';

export type TutorStyle = WorkflowMode;

const MAX_CONTEXT_TOKENS = 6_000;
const MAX_TOTAL_TOKENS = 7_500;

type EmitFn = (type: string, data: Record<string, unknown>) => void;

export interface ExecuteTutorDeps {
    llm: LLMGateway;
    registry: ToolRegistry;
    directory: string;
    emit: EmitFn;
    /** Injected loader — allows assignment-specific policy overlay without subclassing. */
    policyLoader?: PolicyLoader;
    /** Optional guard agent — intercepts prompts before they reach the tutor LLM. */
    guardAgent?: IGuardAgent;
    /** When present, delegates the full guard+tutor pipeline to the backend API. */
    tutorChatGateway?: TutorChatGateway;
}

export interface TutorResult {
    content: string;
    usage: TurnUsage;
}

// ── ExecuteTutorUseCase ───────────────────────────────────────────────────────

export class ExecuteTutorUseCase {
    private readonly policyLoader: PolicyLoader;

    constructor(
        private readonly deps: ExecuteTutorDeps,
        private readonly style: WorkflowMode,
    ) {
        this.policyLoader = deps.policyLoader ?? new PolicyLoader();
    }

    async execute(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
        if (this.deps.tutorChatGateway) {
            return this.callGateway(instruction, history);
        }

        // ── Local fallback (offline / no backend) ────────────────────────────
        this.deps.emit('phase_start', { phase: 'scan', description: 'Scanning workspace for context' });
        const { projectContext, scannedFiles } = await this.buildProjectContext();
        this.deps.emit('phase_end', { phase: 'scan', success: true });

        const fileContents = await this.readRelevantFiles(instruction, scannedFiles);

        const guardBlock = await this.runGuard(instruction, history);
        if (guardBlock) return guardBlock;

        this.deps.emit('phase_start', { phase: 'tutor', description: `Responding in ${this.style} mode` });
        const systemPrompt = this.assemblePrompt(history, instruction, projectContext, fileContents);

        return this.callLLMStream(systemPrompt, instruction, history);
    }

    private async callGateway(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
        this.deps.emit('phase_start', { phase: 'tutor', description: 'Calling tutor API' });

        try {
            const result = await this.deps.tutorChatGateway!.send(instruction, history);

            if (result.status === 'forbidden') {
                this.deps.emit('guard_blocked', { reason: 'content_policy', phase: 'guard' });
                this.deps.emit('text_output', { content: result.content });
                this.deps.emit('phase_end', { phase: 'tutor', success: true });
                return {
                    content: result.content,
                    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 },
                };
            }

            if (result.guardSkipped) {
                this.deps.emit('status_update', { warning: 'guard skipped: llm unavailable' });
            }

            this.deps.emit('text_output', { content: result.content });
            this.deps.emit('phase_end', { phase: 'tutor', success: true });

            return {
                content: result.content,
                usage: {
                    inputTokens:        result.usage.inputTokens,
                    outputTokens:       result.usage.outputTokens,
                    cacheCreationTokens: 0,
                    cacheReadTokens:    0,
                },
            };
        } catch (error) {
            this.deps.emit('phase_end', { phase: 'tutor', success: false });
            this.deps.emit('error', {
                message: error instanceof Error ? error.message : String(error),
                phase: 'tutor',
            });
            throw error;
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async buildProjectContext(): Promise<{
        projectContext: string;
        scannedFiles: Array<{ name: string; path: string }>;
    }> {
        let projectContext = '';
        const scannedFiles: Array<{ name: string; path: string }> = [];

        try {
            const scanTool = this.deps.registry.get('file_scan');
            if (scanTool) {
                const scanResult = await scanTool.execute({ directory: this.deps.directory });
                projectContext = scanResult.content;
                if (scanResult.data) {
                    const data = scanResult.data as { files?: Record<string, Array<{ name: string; path: string }>> };
                    if (data.files) {
                        for (const group of Object.values(data.files)) {
                            if (Array.isArray(group)) {
                                scannedFiles.push(...group.map(file => ({ name: file.name, path: file.path })));
                            }
                        }
                    }
                }
            }
        } catch (error) {
            this.deps.emit('status_update', {
                warning: `Workspace scan failed, continuing without context: ${error instanceof Error ? error.message : String(error)}`,
            });
        }

        return { projectContext, scannedFiles };
    }

    private async readRelevantFiles(
        instruction: string,
        scannedFiles: Array<{ name: string; path: string }>,
    ): Promise<string> {
        const instructionLower = instruction.toLowerCase();
        const readTargets = scannedFiles.filter(file => {
            const nameLower = file.name.toLowerCase();
            if (instructionLower.includes(nameLower)) return true;
            const ext = path.extname(nameLower).slice(1);
            return ext.length > 0 && instructionLower.includes(ext);
        });

        let fileContents = '';
        for (const file of readTargets) {
            try {
                const isPdf = file.name.toLowerCase().endsWith('.pdf');
                const toolName = isPdf ? 'pdf_read' : 'file_read';
                const readTool = this.deps.registry.get(toolName);
                if (readTool) {
                    const result = await readTool.execute({ path: file.path });
                    if (!result.isError) {
                        fileContents += result.content + '\n\n';
                    }
                }
            } catch (error) {
                this.deps.emit('status_update', {
                    warning: `Could not read file ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }

        return fileContents;
    }

    private assemblePrompt(
        history: SessionMessage[],
        instruction: string,
        projectContext: string,
        fileContents: string,
    ): string {
        const policyText = this.policyLoader.load(this.style);
        const basePrompt = buildTutorModePrompt(policyText, this.deps.directory);

        const historyTokens = estimateTokens(history.map(m => m.content).join('\n'));
        const userTokens = estimateTokens(instruction);
        const baseTokens = estimateTokens(basePrompt);
        let budget = MAX_CONTEXT_TOKENS - historyTokens - userTokens - baseTokens;

        let contextSection = '';
        if (projectContext && budget > 200) {
            const ctxTokens = estimateTokens(projectContext);
            if (ctxTokens <= budget) {
                contextSection = `## Project Context\n${projectContext}\n\n`;
                budget -= ctxTokens;
            } else {
                const maxChars = budget * 4;
                contextSection = `## Project Context\n${projectContext.slice(0, maxChars)}\n[…truncated]\n\n`;
                budget = 0;
            }
        }

        let filesSection = '';
        if (fileContents && budget > 200) {
            const fileTokens = estimateTokens(fileContents);
            if (fileTokens <= budget) {
                filesSection = `## File Contents\n${fileContents}`;
            } else {
                const maxChars = budget * 4;
                filesSection = `## File Contents\n${fileContents.slice(0, maxChars)}\n[…truncated]`;
            }
        }

        return basePrompt + contextSection + filesSection;
    }

    private async runGuard(
        instruction: string,
        history: SessionMessage[],
    ): Promise<TutorResult | null> {
        if (!this.deps.guardAgent) return null;

        this.deps.emit('phase_start', { phase: 'guard', description: 'Running safety check' });
        const policyText = this.policyLoader.load(this.style);
        const guardResult = await this.deps.guardAgent.check(instruction, policyText, this.style);
        this.deps.emit('phase_end', { phase: 'guard', success: true, summary: `Guard: ${guardResult.reason}` });

        if (guardResult.allowed) return null;

        switch (guardResult.action) {
            case 'identity': {
                const { identityResponse } = guardResult;
                this.deps.emit('text_output', { content: identityResponse });
                this.deps.emit('phase_end', { phase: 'tutor', success: true });
                return {
                    content: identityResponse,
                    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
                };
            }
            case 'refuse': {
                const { refusalInstruction } = guardResult;
                this.deps.emit('guard_blocked', { reason: guardResult.reason, phase: 'guard' });
                // Use a minimal system prompt (no file contents) so the blocked LLM call
                // cannot see homework answers even through the refusal path.
                const minimalPrompt = buildTutorModePrompt(policyText, this.deps.directory);
                return this.callLLMStream(minimalPrompt, refusalInstruction, history);
            }
        }
    }

    private compactHistory(history: SessionMessage[], systemPrompt: string, userMessage: string): SessionMessage[] {
        const fixed = estimateTokens(systemPrompt) + estimateTokens(userMessage);
        let remaining = [...history];
        while (remaining.length > 2 && fixed + estimateTokens(remaining.map(m => m.content).join('\n')) > MAX_TOTAL_TOKENS) {
            remaining = remaining.slice(2);
        }
        return remaining;
    }

    private async callLLMStream(
        systemPrompt: string,
        instruction: string,
        history: SessionMessage[],
    ): Promise<TutorResult> {
        const turnUsage: TurnUsage = {
            inputTokens: 0, outputTokens: 0,
            cacheCreationTokens: 0, cacheReadTokens: 0,
        };

        const compactedHistory = this.compactHistory(history, systemPrompt, instruction);
        if (compactedHistory.length < history.length) {
            this.deps.emit('status_update', {
                warning: `History compacted: ${history.length} → ${compactedHistory.length} messages to fit token limit`,
            });
        }

        try {
            const response = await this.deps.llm.streamPrompt(
                { systemPrompt, userMessage: instruction, history: compactedHistory },
                (token) => this.deps.emit('stream_token', { token }),
            );

            if (response.usage) {
                turnUsage.inputTokens += response.usage.promptTokens ?? 0;
                turnUsage.outputTokens += response.usage.completionTokens ?? 0;
            }
            if (response.responseTimeMs) {
                turnUsage.responseTimeMs = response.responseTimeMs;
            }

            this.deps.emit('text_output', { content: response.content });
            this.deps.emit('phase_end', { phase: 'tutor', success: true });

            return { content: response.content, usage: turnUsage };
        } catch (error) {
            this.deps.emit('phase_end', { phase: 'tutor', success: false });
            this.deps.emit('error', {
                message: error instanceof Error ? error.message : String(error),
                phase: 'tutor',
            });
            throw error;
        }
    }
}
