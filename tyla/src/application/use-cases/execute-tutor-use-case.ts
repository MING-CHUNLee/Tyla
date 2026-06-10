/**
 * Use Case: ExecuteTutorUseCase
 *
 * Tutor workflow mode pipeline (Option B).
 * guardCheckGateway and tutorChatGateway are required — the factory must not construct
 * this use case unless both gateways are available.
 *
 * Returns TutorResult — the caller is responsible for persisting the turn.
 */

import path from 'path';
import { TurnUsage } from '../../domain/entities/conversation-turn';
import { ToolRegistry } from '../orchestration/tool-registry';
import { SessionMessage } from '../../shared/types/messages';
import { TutorChatGateway } from '../../infrastructure/api/tutor/tutor-chat-gateway';
import { GuardCheckGateway } from '../../infrastructure/api/guard/guard-check-gateway';
import { EditStagingService } from '../services/edit-staging-service';
import { DiffEngine } from '../services/diff-engine';
import { FileContextBudget } from '../services/file-context-budget';
import { IFileSystem } from '../../domain/types/file-system';
import { LocalFileSystem } from '../../infrastructure/filesystem/local-file-system';
import { TutorAction, EditPatch } from '../../shared/types/tutor-actions';
import { ContinuationFileLoader } from '../services/continuation-file-loader';
import { PathConfinement } from '../../domain/policies/path-confinement';
import { extractPdfText } from '../../infrastructure/pdf/pdf-text-extractor';

const FALLBACK_FILE_LIMIT = 5;                     // read at most N when nothing is named

// ── file_context token budget (gap-list §C) ───────────────────────────────────
// The base auto-read must obey the same caps as a B3 continuation load, or the
// base context alone overruns the backend's ~8K budget on turn 0. Calibrated for
// GitHub Models: ~5K static base leaves ~3K, so file_context ≲ ~2.2K keeps room
// for history/summary. Tune in §8 Phase 0 once measured.
const PER_FILE_TOKEN_CAP = 1_200;                  // no single file dominates the pool
const PER_TURN_FILE_CONTEXT_TOKEN_CAP = 2_200;     // base + loaded combined
// Code/source groups only. Data (rData / dataFiles / rProject) AND documents (PDFs etc.)
// are never auto-read — documents are large and the assignment policy may already carry
// their content, so they load name-only (only when the student references them).
// Order = preference. THIS is the one-line seam for new languages: add 'pythonScripts'
// once file_scan surfaces it.
const FALLBACK_GROUPS = ['rScripts', 'rMarkdown'] as const;

const MAX_CONTINUATIONS = 3;   // hard termination invariant (b3 §4.4, §8); lower to 2 after Phase 0

type ScannedFile = { name: string; path: string; group: string };

type EmitFn = (type: string, data: Record<string, unknown>) => void;

export interface ExecuteTutorDeps {
    registry: ToolRegistry;
    directory: string;
    emit: EmitFn;
/** Delegates the full guard+tutor pipeline to the backend API. */
    tutorChatGateway: TutorChatGateway;
    /** Option B pre-call. Runs the guard→tutor→actions pipeline. */
    guardCheckGateway: GuardCheckGateway;
    /** Human-in-the-loop gate for edit_file / execute_script. Same contract as the edit pipeline. */
    onApproval?: (edit: { path: string; diff: string; diffLines: import('../services/diff-engine').DiffLine[]; original: string; proposed: string }) => Promise<boolean>;
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
    private readonly fileSystem: IFileSystem;
    private readonly stagingService: EditStagingService;
    private readonly loader: ContinuationFileLoader;

    constructor(private readonly deps: ExecuteTutorDeps) {
        this.fileSystem = deps.fileSystem ?? new LocalFileSystem();
        this.stagingService = deps.stagingService ??
            new EditStagingService(this.fileSystem, deps.diffEngine ?? new DiffEngine());
        this.loader = new ContinuationFileLoader(this.fileSystem, new PathConfinement(this.fileSystem), extractPdfText);
    }

    async execute(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
        // Backend owns guard + prompt composition + LLM call. callGateway() guards against missing gateways.
        return this.callGateway(instruction, history);
    }

    // ── Option B orchestration ────────────────────────────────────────────────

    private async callGateway(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
        // ── 1. file_context (reuses scan + read helpers) ───────────────────────
        // Single budget instance for the whole turn: base reads and B3 continuation
        // loads draw from one shared pool (gap-list §C, b3 §2.3).
        const budget = new FileContextBudget(PER_FILE_TOKEN_CAP, PER_TURN_FILE_CONTEXT_TOKEN_CAP);
        const baseContext = await this.buildFileContext(instruction, budget);

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

        // ── 3. B3 continuation loop (G1+G4+G5+G6+G9) ─────────────────────────
        const resolved = new Map<string, 'loaded' | 'unavailable'>();
        const loadedBlocks: string[] = [];
        let usage = toTurnUsage(guard.usage);

        for (let i = 0; ; i++) {
            const fileContext = loadedBlocks.length
                ? `${baseContext}\n\n## Files Loaded On Request\n${loadedBlocks.join('\n')}`
                : baseContext;

            this.deps.emit('phase_start', { phase: 'tutor', description: i === 0 ? 'Calling tutor API' : `Continuation ${i}` });
            let result;
            try {
                result = await this.deps.tutorChatGateway.send(instruction, history, guard.logId, fileContext);
            } catch (error) {
                return this.failTutor('tutor', error);
            }
            usage = addUsage(usage, toTurnUsage(result.usage));

            if (result.status === 'forbidden') {
                this.deps.emit('guard_blocked', { reason: 'guard_credential', phase: 'tutor' });
                this.deps.emit('text_output', { content: result.content });
                this.deps.emit('phase_end', { phase: 'tutor', success: true });
                return { content: result.content, usage };
            }
            if (result.status === 'error') {
                this.deps.emit('phase_end', { phase: 'tutor', success: false });
                this.deps.emit('error', { message: `Tutor call failed: ${result.content || 'unknown error'}. Please try again.`, phase: 'tutor' });
                return { content: result.content, usage };
            }
            if (result.guardSkipped) {
                this.deps.emit('status_update', { warning: 'tutor: guard credential accepted under fail-open' });
            }

            // Collect and resolve new load_file actions (G4+G7)
            const loads = result.actions.filter(
                (a): a is Extract<TutorAction, { type: 'load_file' }> => a.type === 'load_file',
            );
            let madeProgress = false;
            if (i < MAX_CONTINUATIONS) {
                for (const a of loads) {
                    const r = await this.loader.resolve(this.deps.directory, a.path, budget);
                    if (resolved.has(r.key)) continue;
                    resolved.set(r.key, r.ok ? 'loaded' : 'unavailable');
                    loadedBlocks.push(r.block);
                    madeProgress = true;
                }
            } else if (loads.length > 0) {
                this.deps.emit('status_update', { warning: `Reached MAX_CONTINUATIONS (${MAX_CONTINUATIONS}) — stopping automatic file loading` });
            }

            if (madeProgress) {
                this.deps.emit('continuation', {
                    iteration: i + 1,
                    loaded: [...resolved.keys()],
                    intermediateContent: result.content,
                });
                continue;
            }

            // Terminal turn: emit text + dispatch (load_file already consumed by driver)
            this.deps.emit('text_output', { content: result.content });
            this.deps.emit('phase_end', { phase: 'tutor', success: true });
            await this.dispatchActions(result.actions.filter(a => a.type !== 'load_file'));
            return { content: result.content, usage };
        }
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
            path: staged.staged.path, diff: staged.staged.diff, diffLines: staged.staged.diffLines,
            original: staged.staged.original, proposed: staged.staged.content,
        });

        const approved = this.deps.onApproval
            ? await this.deps.onApproval({
                path: staged.staged.path, diff: staged.staged.diff, diffLines: staged.staged.diffLines,
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
            ? await this.deps.onApproval({ path: '(r script)', diff: action.code, diffLines: [], original: '', proposed: action.code })
            : false;
        if (!approved) { this.deps.emit('script_rejected', {}); return; }

        const rExec = this.deps.registry.get('r_exec'); // read-only guard lives in the tool
        if (!rExec) { this.deps.emit('status_update', { warning: 'r_exec tool not registered' }); return; }
        const res = await rExec.execute({ code: action.code });
        this.deps.emit('tool_result_r_exec', { data: res.data ?? { stdout: res.content } });
    }

    // ── file_context assembly (Option B) ──────────────────────────────────────

    private async buildFileContext(instruction: string, budget: FileContextBudget): Promise<string> {
        this.deps.emit('phase_start', { phase: 'scan', description: 'Building file context' });
        const { projectContext, scannedFiles } = await this.buildProjectContext();   // (i)  file_scan

        // (ii) explicit match first; (iv) fall back to the top-N source files if nothing named.
        let fileContents = await this.readRelevantFiles(instruction, scannedFiles, budget);
        if (!fileContents) {
            fileContents = await this.readFallbackFiles(scannedFiles, budget);
        }
        this.deps.emit('phase_end', { phase: 'scan', success: true });

        const parts: string[] = [];
        if (projectContext) parts.push(`## Project Context\n${projectContext}`);
        if (fileContents)   parts.push(`## File Contents\n${fileContents}`);

        return parts.join('\n\n');
    }

    private async readFallbackFiles(scannedFiles: ScannedFile[], budget: FileContextBudget): Promise<string> {
        const ranked = scannedFiles
            .filter(f => (FALLBACK_GROUPS as readonly string[]).includes(f.group))
            .sort((a, b) => FALLBACK_GROUPS.indexOf(a.group as never) - FALLBACK_GROUPS.indexOf(b.group as never));

        const targets = ranked.slice(0, FALLBACK_FILE_LIMIT);
        if (targets.length === 0) return '';
        this.deps.emit('status_update', {
            info: `No file named — auto-loading ${targets.length} source file(s): ${targets.map(t => t.name).join(', ')}`,
        });

        // Sequential (readFiles loops in order) so the shared per-turn budget is
        // drawn down deterministically — overflow refuses the *later* files with a
        // marker rather than racing a Promise.all. (gap-list §C)
        return this.readFiles(targets, budget);
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
        budget: FileContextBudget,
    ): Promise<string> {
        const instructionLower = instruction.toLowerCase();
        const readTargets = scannedFiles.filter(file => {
            const nameLower = file.name.toLowerCase();
            if (instructionLower.includes(nameLower)) return true;       // "...my hw11.R..." → match
            const ext = path.extname(nameLower).slice(1);
            return ext.length > 0 && instructionLower.includes(ext);     // "...the .R file..." → match
        });

        return this.readFiles(readTargets, budget);
    }

    /**
     * Read a fixed set of files through ContinuationFileLoader.resolve(), concatenating
     * their contents under the shared per-turn token budget (gap-list §C). Each file is
     * capped per-file; once the per-turn pool is spent the remaining files are refused
     * with a visible marker rather than silently dropped. PDF, binary, and symlink-escape
     * checks are all handled inside the loader.
     */
    private async readFiles(targets: Array<{ name: string; path: string }>, budget: FileContextBudget): Promise<string> {
        let out = '';
        for (const file of targets) {
            if (budget.isExhausted()) {
                out += budget.skipMarker(file.name);
                this.deps.emit('status_update', { warning: `file_context token budget reached — skipped ${file.name}` });
                continue;
            }
            try {
                // file.path from file_scan is absolute; PathConfinement requires relative paths,
                // so normalize before passing to the loader (which handles PDF/binary/budget too).
                const absPath = path.isAbsolute(file.path)
                    ? file.path
                    : path.resolve(this.deps.directory, file.path);
                const relativePath = path.relative(this.deps.directory, absPath);
                const resolution = await this.loader.resolve(this.deps.directory, relativePath, budget);
                out += resolution.block;
                if (!resolution.ok) {
                    this.deps.emit('status_update', { warning: `Could not load ${file.name} for context` });
                }
            } catch (error) {
                this.deps.emit('status_update', {
                    warning: `Could not read file ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }
        return out;
    }
}
