/**
 * Use Case: ExecuteTutorUseCase
 *
 * Tutor workflow mode pipeline (Option B). Requires guardCheckGateway + tutorChatGateway.
 * Without them, callGateway() surfaces a friendly "backend not configured" error rather than
 * failing silently.
 *
 * Returns TutorResult — the caller is responsible for persisting the turn.
 */

import path from 'path';
import { TurnUsage } from '../../domain/entities/conversation-turn';
import { ToolRegistry } from '../orchestration/tool-registry';
import { SessionMessage } from '../../shared/types/messages';
import { estimateTokens } from '../prompts';
import { PolicyLoader } from '../../infrastructure/config/policy-loader';
import { TutorChatGateway } from '../../infrastructure/api/tutor/tutor-chat-gateway';
import { GuardCheckGateway } from '../../infrastructure/api/guard/guard-check-gateway';
import { EditStagingService } from '../services/edit-staging-service';
import { DiffEngine } from '../services/diff-engine';
import { IFileSystem } from '../../domain/types/file-system';
import { LocalFileSystem } from '../../infrastructure/filesystem/local-file-system';
import { TutorAction, EditPatch } from '../../shared/types/tutor-actions';

const MAX_CONTEXT_TOKENS = 6_000;

const FALLBACK_FILE_LIMIT = 5;                     // read at most N when nothing is named
// Code/source groups only. Data (rData / dataFiles / rProject) AND documents (PDFs etc.)
// are never auto-read — documents are large and the assignment policy may already carry
// their content, so they load name-only (only when the student references them).
// Order = preference. THIS is the one-line seam for new languages: add 'pythonScripts'
// once file_scan surfaces it.
const FALLBACK_GROUPS = ['rScripts', 'rMarkdown'] as const;

type ScannedFile = { name: string; path: string; group: string };

type EmitFn = (type: string, data: Record<string, unknown>) => void;

export interface ExecuteTutorDeps {
    registry: ToolRegistry;
    directory: string;
    emit: EmitFn;
    /** Injected loader — allows assignment-specific policy overlay without subclassing. */
    policyLoader?: PolicyLoader;
    /** When present, delegates the full guard+tutor pipeline to the backend API. */
    tutorChatGateway?: TutorChatGateway;
    /** Option B pre-call. When present (with tutorChatGateway), runs the guard→tutor→actions pipeline. */
    guardCheckGateway?: GuardCheckGateway;
    /** Human-in-the-loop gate for edit_file / execute_script. Same contract as the edit pipeline. */
    onApproval?: (edit: { path: string; diff: string; original: string; proposed: string }) => Promise<boolean>;
    /** Defaults built from fileSystem + diffEngine below. */
    stagingService?: EditStagingService;
    diffEngine?: DiffEngine;
    fileSystem?: IFileSystem;
}

export interface TutorResult {
    content: string;
    usage: TurnUsage;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** First-occurrence search-replace; skip-and-warn on a missing search string. */
function applyPatches(original: string, patches: EditPatch[], warn: (m: string) => void): string {
    let out = original;
    for (const { search, replace } of patches) {
        if (!out.includes(search)) { warn(`patch search text not found, skipped`); continue; }
        out = out.replace(search, replace); // first occurrence only
    }
    return out;
}

function toTurnUsage(u: { inputTokens: number; outputTokens: number }): TurnUsage {
    return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheCreationTokens: 0, cacheReadTokens: 0,
    };
}

// ── ExecuteTutorUseCase ───────────────────────────────────────────────────────

export class ExecuteTutorUseCase {
    private readonly policyLoader: PolicyLoader;
    private readonly fileSystem: IFileSystem;
    private readonly stagingService: EditStagingService;

    constructor(private readonly deps: ExecuteTutorDeps) {
        this.policyLoader = deps.policyLoader ?? new PolicyLoader();
        this.fileSystem = deps.fileSystem ?? new LocalFileSystem();
        this.stagingService = deps.stagingService ??
            new EditStagingService(this.fileSystem, deps.diffEngine ?? new DiffEngine());
    }

    async execute(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
        // Backend owns guard + prompt composition + LLM call. callGateway() guards against missing gateways.
        return this.callGateway(instruction, history);
    }

    // ── Option B orchestration ────────────────────────────────────────────────

    private async callGateway(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
        // ── 0. Guard the gateways ──────────────────────────────────────────────
        // After §5e removes the offline path, execute() calls straight here. Without
        // these checks, an undefined gateway throws a raw TypeError. Surface a clear
        // message instead.
        if (!this.deps.guardCheckGateway || !this.deps.tutorChatGateway) {
            const msg = 'Tutor backend not configured — set a valid profile.json and restart tyla.';
            this.deps.emit('error', { message: msg, phase: 'guard' });
            throw new Error(msg);
        }

        // ── 1. file_context (reuses scan + read helpers) ───────────────────────
        const fileContext = await this.buildFileContext(instruction);

        // ── 2. Guard pre-call ──────────────────────────────────────────────────
        this.deps.emit('phase_start', { phase: 'guard', description: 'Running safety check' });
        let guard;
        try {
            guard = await this.deps.guardCheckGateway.check(instruction);
        } catch (error) {
            return this.failTutor('guard', error);
        }
        this.deps.emit('phase_end', { phase: 'guard', success: true });

        if (guard.status === 'forbidden') {
            this.deps.emit('guard_blocked', { reason: 'content_policy', phase: 'guard' });
            this.deps.emit('text_output', { content: guard.refusal });
            return { content: guard.refusal, usage: toTurnUsage(guard.usage) };
        }
        if (guard.status === 'error') {
            // decision doc §3.1: no log_id produced → cannot proceed. Show + retry.
            this.deps.emit('error', { message: `Safety check failed: ${guard.message}. Please try again.`, phase: 'guard' });
            return { content: '', usage: toTurnUsage(guard.usage) };
        }
        if (guard.guardSkipped) {
            this.deps.emit('status_update', { warning: 'guard skipped: llm unavailable' });
        }

        // ── 3. Tutor call ──────────────────────────────────────────────────────
        this.deps.emit('phase_start', { phase: 'tutor', description: 'Calling tutor API' });
        let result;
        try {
            result = await this.deps.tutorChatGateway.send(instruction, history, guard.logId, fileContext);
        } catch (error) {
            return this.failTutor('tutor', error);
        }

        if (result.status === 'forbidden') {
            // guard_log_id rejected by the backend (missing/invalid/mismatch)
            this.deps.emit('guard_blocked', { reason: 'guard_credential', phase: 'tutor' });
            this.deps.emit('text_output', { content: result.content });
            this.deps.emit('phase_end', { phase: 'tutor', success: true });
            return { content: result.content, usage: addUsage(toTurnUsage(guard.usage), toTurnUsage(result.usage)) };
        }
        if (result.status === 'error') {
            // server/judge error on the tutor leg — show + retry, no actions.
            this.deps.emit('phase_end', { phase: 'tutor', success: false });
            this.deps.emit('error', { message: `Tutor call failed: ${result.content || 'unknown error'}. Please try again.`, phase: 'tutor' });
            return { content: result.content, usage: addUsage(toTurnUsage(guard.usage), toTurnUsage(result.usage)) };
        }
        if (result.guardSkipped) {
            this.deps.emit('status_update', { warning: 'tutor: guard credential accepted under fail-open' });
        }

        this.deps.emit('text_output', { content: result.content });
        this.deps.emit('phase_end', { phase: 'tutor', success: true });

        // ── 4. Dispatch actions behind the approval gate ───────────────────────
        await this.dispatchActions(result.actions);

        // guard + tutor usages are disjoint (tutor no longer re-runs guard) — summing is safe.
        // NOTE: `actions` are dispatched here and intentionally NOT returned on TutorResult —
        // Phase 1 does not persist "which actions were proposed" in session history.
        // TODO(Phase 2 / Option A): thread `actions` onto TutorResult if session replay needs them.
        return { content: result.content, usage: addUsage(toTurnUsage(guard.usage), toTurnUsage(result.usage)) };
    }

    private failTutor(phase: 'guard' | 'tutor', error: unknown): never {
        this.deps.emit('phase_end', { phase, success: false });
        this.deps.emit('error', { message: error instanceof Error ? error.message : String(error), phase });
        throw error;
    }

    // ── Action dispatch (approval gate) ───────────────────────────────────────

    private async dispatchActions(actions: TutorAction[]): Promise<void> {
        if (actions.length === 0) return;
        this.deps.emit('phase_start', { phase: 'actions', description: `Dispatching ${actions.length} action(s)` });

        for (const action of actions) {
            switch (action.type) {
                case 'edit_file':      await this.dispatchEditFile(action); break;
                case 'execute_script': await this.dispatchExecuteScript(action); break;
                case 'load_file':      await this.dispatchLoadFile(action); break;
            }
        }

        this.deps.emit('phase_end', { phase: 'actions', success: true });
    }

    private async dispatchEditFile(action: { path: string; patches: EditPatch[] }): Promise<void> {
        const absPath = path.resolve(this.deps.directory, action.path);

        let original = '';
        try {
            original = this.fileSystem.read(absPath);
        } catch {
            original = ''; // new file
        }

        const proposed = applyPatches(original, action.patches,
            (msg) => this.deps.emit('status_update', { warning: `edit_file ${action.path}: ${msg}` }));

        // stageOnly() does NOT push to the drain queue (the tutor applies per-action, never
        // drains), and stores the *relative* path for display while resolving against
        // `directory` for read/apply — so the diff header shows `hw11.R`, not an absolute path.
        const staged = this.stagingService.stageOnly(action.path, proposed, this.deps.directory);
        if ('error' in staged) {
            if (staged.isHardError) this.deps.emit('error', { message: staged.error, phase: 'actions' });
            else this.deps.emit('status_update', { warning: staged.error });
            return;
        }

        this.deps.emit('diff_proposed', {
            path: staged.staged.path, diff: staged.staged.diff,        // relative
            original: staged.staged.original, proposed: staged.staged.content,
        });

        const approved = this.deps.onApproval
            ? await this.deps.onApproval({
                path: staged.staged.path, diff: staged.staged.diff,
                original: staged.staged.original, proposed: staged.staged.content,
              })
            : false;

        if (approved) {
            this.stagingService.applyEdit(staged.staged);             // uses staged.absPath
            this.deps.emit('edit_applied', { path: action.path });
        } else {
            this.deps.emit('edit_rejected', { path: action.path });
        }
    }

    private async dispatchExecuteScript(action: { code: string }): Promise<void> {
        this.deps.emit('script_proposed', { code: action.code });
        const approved = this.deps.onApproval
            ? await this.deps.onApproval({ path: '(r script)', diff: action.code, original: '', proposed: action.code })
            : false;
        if (!approved) { this.deps.emit('script_rejected', {}); return; }

        const rExec = this.deps.registry.get('r_exec'); // read-only guard lives in the tool
        if (!rExec) { this.deps.emit('status_update', { warning: 'r_exec tool not registered' }); return; }
        const res = await rExec.execute({ code: action.code });
        this.deps.emit('tool_result_r_exec', { data: res.data ?? { stdout: res.content } });
    }

    private async dispatchLoadFile(action: { path: string }): Promise<void> {
        const readTool = this.deps.registry.get(action.path.toLowerCase().endsWith('.pdf') ? 'pdf_read' : 'file_read');
        if (!readTool) return;
        const res = await readTool.execute({ path: action.path });
        if (!res.isError) this.deps.emit('text_output', { content: res.content });
    }

    // ── file_context assembly (Option B) ──────────────────────────────────────

    private async buildFileContext(instruction: string): Promise<string> {
        this.deps.emit('phase_start', { phase: 'scan', description: 'Building file context' });
        const { projectContext, scannedFiles } = await this.buildProjectContext();   // (i)  file_scan

        // (ii) explicit match first; (iv) fall back to the top-N source files if nothing named.
        let fileContents = await this.readRelevantFiles(instruction, scannedFiles);
        if (!fileContents) {
            fileContents = await this.readFallbackFiles(scannedFiles);
        }
        this.deps.emit('phase_end', { phase: 'scan', success: true });

        const parts: string[] = [];
        if (projectContext) parts.push(`## Project Context\n${projectContext}`);
        if (fileContents)   parts.push(`## File Contents\n${fileContents}`);

        // Cap file context so the backend never receives an oversized payload.
        return this.truncateToTokenBudget(parts.join('\n\n'), MAX_CONTEXT_TOKENS);
    }

    private truncateToTokenBudget(text: string, budget: number): string {
        if (estimateTokens(text) <= budget) return text;
        return text.slice(0, budget * 4) + '\n[…truncated]';   // ~4 chars/token
    }

    private async readFallbackFiles(scannedFiles: ScannedFile[]): Promise<string> {
        const ranked = scannedFiles
            .filter(f => (FALLBACK_GROUPS as readonly string[]).includes(f.group))
            .sort((a, b) => FALLBACK_GROUPS.indexOf(a.group as never) - FALLBACK_GROUPS.indexOf(b.group as never));

        const targets = ranked.slice(0, FALLBACK_FILE_LIMIT);
        if (targets.length === 0) return '';
        this.deps.emit('status_update', {
            info: `No file named — auto-loading ${targets.length} source file(s): ${targets.map(t => t.name).join(', ')}`,
        });

        // Read one at a time, stop early once we'd exceed the context budget (avoid wasted reads).
        let out = '';
        for (const file of targets) {
            const chunk = await this.readFiles([file]);
            if (estimateTokens(out + chunk) > MAX_CONTEXT_TOKENS) break;
            out += chunk;
        }
        return out;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async buildProjectContext(): Promise<{
        projectContext: string;
        scannedFiles: ScannedFile[];
    }> {
        let projectContext = '';
        const scannedFiles: ScannedFile[] = [];

        try {
            const scanTool = this.deps.registry.get('file_scan');
            if (scanTool) {
                const scanResult = await scanTool.execute({ directory: this.deps.directory });
                projectContext = scanResult.content;
                if (scanResult.data) {
                    const data = scanResult.data as { files?: Record<string, Array<{ name: string; path: string }>> };
                    if (data.files) {
                        for (const [group, files] of Object.entries(data.files)) {
                            if (Array.isArray(files)) {
                                scannedFiles.push(...files.map(file => ({ name: file.name, path: file.path, group })));
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
        scannedFiles: ScannedFile[],
    ): Promise<string> {
        const instructionLower = instruction.toLowerCase();
        const readTargets = scannedFiles.filter(file => {
            const nameLower = file.name.toLowerCase();
            if (instructionLower.includes(nameLower)) return true;       // "...my hw11.R..." → match
            const ext = path.extname(nameLower).slice(1);
            return ext.length > 0 && instructionLower.includes(ext);     // "...the .R file..." → match
        });

        return this.readFiles(readTargets);
    }

    /** Read a fixed set of files through file_read / pdf_read, concatenating their contents. */
    private async readFiles(targets: Array<{ name: string; path: string }>): Promise<string> {
        let out = '';
        for (const file of targets) {
            try {
                const tool = this.deps.registry.get(file.name.toLowerCase().endsWith('.pdf') ? 'pdf_read' : 'file_read');
                if (!tool) continue;
                const result = await tool.execute({ path: file.path });
                if (!result.isError) out += `### ${file.name}\n${result.content}\n\n`;
            } catch (error) {
                this.deps.emit('status_update', {
                    warning: `Could not read file ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }
        return out;
    }
}
