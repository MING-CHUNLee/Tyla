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
import { AnchoredLine, parseNumberedLines, stripLineNumberPrefixes } from '../services/line-numbering';

// ── file_context token budget (plan 2026-06-11 §2.4) ─────────────────────────
// One shared per-turn pool for @-mentioned files AND B3 continuation loads —
// the last line of defence against the backend's whole-or-drop context_overflow
// (ContinuationFileLoader has no other size guard, and B3 load_file is
// LLM-initiated, outside the student's control). Widened from 2,200 with
// @-gating so a student-named file is almost never truncated; overridable via
// env until Phase 0 measurement settles the number.
const PER_TURN_FILE_CONTEXT_TOKEN_CAP =
    Number(process.env.TYLA_FILE_CONTEXT_TOKEN_CAP) || 6_000;

// @-mention parser (§2.4) — shared convention with the TUI hint and
// line-numbering. Path character set; `@"..."` for names with spaces is a
// later extension.
const FILE_MENTION_RE = /@([\w\-./\\]+)/g;

// Backend trim notices → student-facing messages (§2.7). The warning is a
// safety net for the backend's whole-or-drop trimming; the per-turn budget
// above is the primary defence (graceful head-truncation).
const BACKEND_WARNING_MESSAGES: Record<string, string> = {
    file_context_dropped: '檔案內容超過後端預算，本回合 tutor 沒有看到你的檔案',
    history_truncated:    '對話歷史過長，較早的回合已被省略',
};

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

/**
 * Two-layer patch application (plan 2026-06-11 §2.3).
 *
 * Layer 1 — anchored: `search` lines carry `N| ` prefixes pointing at real file
 * lines. Verify the file slice matches the de-prefixed search (trimEnd-loose to
 * tolerate trailing whitespace), then splice in the de-prefixed replace. Anchors
 * all reference ORIGINAL line numbers, so anchored patches apply bottom-up —
 * earlier anchors are unaffected when a later patch changes the line count.
 * The verification doubles as stale-context protection: if the student edited
 * the file since the numbers were issued, the mismatch demotes the patch to…
 *
 * Layer 2 — text fallback: strip any prefixes and replace the first occurrence
 * (the pre-line-number behaviour). Both layers failing → skip-and-warn.
 */
function applyNumberedPatches(original: string, patches: EditPatch[], warn: (m: string) => void): string {
    const anchored: Array<{ start: number; searchLines: AnchoredLine[]; replace: string }> = [];
    const textPatches: EditPatch[] = [];
    for (const patch of patches) {
        const parsed = parseNumberedLines(patch.search);
        if (parsed) anchored.push({ start: parsed[0].lineNo, searchLines: parsed, replace: patch.replace });
        else textPatches.push(patch);
    }

    const lines = original.split('\n');
    anchored.sort((a, b) => b.start - a.start);                     // bottom-up
    for (const { start, searchLines, replace } of anchored) {
        const idx = start - 1;
        const slice = lines.slice(idx, idx + searchLines.length);
        const matches = idx >= 0 && idx + searchLines.length <= lines.length
            && searchLines.every((searchLine, i) => slice[i].trimEnd() === searchLine.text.trimEnd());
        if (matches) {
            const replaceLines = replace === '' ? [] : stripLineNumberPrefixes(replace).split('\n');
            lines.splice(idx, searchLines.length, ...replaceLines);
        } else {
            warn(`line anchor ${start} did not match current file content — falling back to text search`);
            textPatches.push({ search: searchLines.map(l => l.text).join('\n'), replace });
        }
    }

    let out = lines.join('\n');
    for (const { search, replace } of textPatches) {
        const plainSearch = stripLineNumberPrefixes(search);
        if (!out.includes(plainSearch)) { warn(`patch search text not found, skipped`); continue; }
        out = out.replace(plainSearch, stripLineNumberPrefixes(replace)); // first occurrence only
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
        const budget = new FileContextBudget(PER_TURN_FILE_CONTEXT_TOKEN_CAP);
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
        const emittedWarnings = new Set<string>();
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
            // §2.7: backend trim notices → visible warnings (deduped across continuations).
            for (const code of result.warnings ?? []) {
                if (emittedWarnings.has(code)) continue;
                emittedWarnings.add(code);
                this.deps.emit('status_update', { warning: BACKEND_WARNING_MESSAGES[code] ?? `backend warning: ${code}` });
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

        const proposed = applyNumberedPatches(original, action.patches,
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
        // file_scan stays unconditional but name-only (decision 1): the cheap
        // Project Context list is what lets the B3 load_file loop know which
        // workspace files it can request. Content reads are @-gated below.
        const { projectContext, scannedFiles } = await this.buildProjectContext();
        const fileContents = await this.readMentionedFiles(instruction, scannedFiles, budget);
        this.deps.emit('phase_end', { phase: 'scan', success: true });

        const parts: string[] = [];
        if (projectContext) parts.push(`## Project Context\n${projectContext}`);
        if (fileContents)   parts.push(`## File Contents\n${fileContents}`);

        return parts.join('\n\n');
    }

    /**
     * @-gated content reads (plan 2026-06-11 §2.4): only files the student
     * explicitly names with `@<file>` are loaded. Each token is matched against
     * the file_scan results by basename (case-insensitive); an unmatched token
     * is handed to the loader as a relative path (confinement blocks escapes),
     * so a miss yields an unavailable marker + warning — visible to both the
     * LLM and the student, never a silent drop.
     */
    private async readMentionedFiles(
        instruction: string,
        scannedFiles: ScannedFile[],
        budget: FileContextBudget,
    ): Promise<string> {
        const tokens = [...instruction.matchAll(FILE_MENTION_RE)].map(m => m[1]);
        if (tokens.length === 0) return '';

        const seen = new Set<string>();
        const targets: Array<{ name: string; path: string }> = [];
        for (const token of tokens) {
            const key = token.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const basename = path.basename(key);
            const match = scannedFiles.find(file => file.name.toLowerCase() === basename);
            targets.push(match ?? { name: token, path: token });
        }

        // Sequential so the shared per-turn budget is drawn down deterministically —
        // overflow refuses the *later* files with a marker rather than racing a Promise.all.
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

    /**
     * Read a fixed set of files through ContinuationFileLoader.resolve(), concatenating
     * their contents under the shared per-turn token budget; once the pool is spent the
     * remaining files are refused with a visible marker rather than silently dropped.
     * PDF, binary, and symlink-escape checks are all handled inside the loader.
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
