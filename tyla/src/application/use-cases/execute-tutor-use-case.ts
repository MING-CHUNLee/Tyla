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
import { isAxiosError } from 'axios';
import { TurnUsage, ApiLogEntry } from '../../domain/entities/conversation-turn';
import { ToolRegistry } from '../orchestration/tool-registry';
import { SessionMessage } from '../../shared/types/messages';
import { SessionTurn } from '../../shared/types/session-turn';
import { TutorChatGateway } from '../../infrastructure/api/tutor/tutor-chat-gateway';
import { GuardCheckGateway } from '../../infrastructure/api/guard/guard-check-gateway';
import { EditStagingService } from '../services/edit-staging-service';
import { DiffEngine } from '../services/diff-engine';
import { FileContextBudget } from '../services/file-context-budget';
import { IFileSystem } from '../../domain/types/file-system';
import { LocalFileSystem } from '../../infrastructure/filesystem/local-file-system';
import { TutorAction, EditPatch } from '../../shared/types/tutor-actions';
import { ContinuationFileLoader, LoadResolution } from '../services/continuation-file-loader';
import { PathConfinement } from '../../domain/policies/path-confinement';
import { extractPdfText } from '../../infrastructure/pdf/pdf-text-extractor';
import { stripLineNumberPrefixes } from '../services/line-numbering';

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
    file_context_dropped: 'Your file exceeded the backend budget, so the tutor could not see it this turn',
    history_truncated:    'The conversation history was too long, so earlier turns were omitted',
    reference_loaded:     'The tutor consulted the reference solution this turn',
    // plan 2026-06-12 §4: the cheap workspace manifest was dropped to fit the budget.
    workspace_overview_dropped: 'The workspace file list exceeded the backend budget, so the tutor could not see the full file list this turn',
    // plan 2026-06-12 §2.2: the tutor tried to edit a file it had not loaded; the
    // backend rewrote the edit to load_file, so the real edit lands one turn later.
    edit_file_redirected: 'The tutor tried to edit a file it had not loaded yet, so it loaded the file first (this costs one extra turn)',
    // plan 2026-06-13 §4.2: the backend's RedundantLoadGate dropped a load_file for
    // an already-loaded path (structural termination; the frontend dedup independently
    // prevents the same re-request from reaching the backend at all).
    redundant_load_dropped: 'The tutor tried to reload a file that was already loaded; the duplicate request was dropped',
    // plan 2026-06-16-session-token-limit-signal (A) — per-request context limit.
    // Action: start a new conversation (context is cleared). MUST stay distinct from
    // provider_rate_limited below — the user actions are opposite (plan 2026-06-18 §6).
    session_limit_reached:
        'This conversation is too long for the current request. Start a new conversation to continue.',
    // plan 2026-06-18-provider-rate-limit-passthrough (C2) — account-level rate window.
    // Action: wait for the window to reset; opening a new conversation does NOT help.
    provider_rate_limited:
        'Your API key quota is running low for this period. Please wait before sending more messages.',
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
    apiLogs: ApiLogEntry[];
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Patch application — line anchor + content verify (plan 2026-06-13 §2 decision B,
 * §5 front-end algorithm).
 *
 * Each patch carries `start_line` (1-based, the file line of `search`'s first line —
 * the model reads it from the `N| ` prefix the live workspace context shows it) plus
 * PLAIN `search`/`replace` content (no prefixes). For each anchored patch we:
 *   1. anchor at `start_line`, take the file slice of the same length as `search`;
 *   2. verify it matches `search` line-for-line — CRLF-normalised (workspace files
 *      are `\r\n`; plan §7 D3) and trailing-whitespace-loose;
 *   3. on match, splice in `replace`; on mismatch, REJECT + warn — never silently
 *      edit the wrong line. The content check is the last gate against an off-by-one
 *      or hallucinated `start_line` (plan §7 D1) and against stale context.
 *
 * Anchors reference ORIGINAL line numbers, so anchored patches apply bottom-up — a
 * later splice never shifts an earlier (smaller) anchor.
 *
 * Defensive (plan §5.4 / §7 D4):
 *   - A patch with no usable `start_line` (XML fallback) degrades to a UNIQUE text
 *     match — applied only if `search` occurs exactly once, else rejected. Never a
 *     blind first-occurrence replace.
 *   - Any stray `N| ` prefix a model still jams into search/replace is stripped.
 */
function applyAnchoredPatches(original: string, patches: EditPatch[], warn: (m: string) => void): string {
    // Detect EOL once; split into pure content lines so CRLF never leaks into the
    // comparison and the rejoined file keeps a single, consistent line ending.
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/);

    // The verify gate: CRLF- and trailing-whitespace-loose line equality.
    const sameLine = (a: string, b: string) => a.trimEnd() === b.trimEnd();
    const searchLinesOf = (s: string) => stripLineNumberPrefixes(s).split(/\r?\n/);
    const replaceLinesOf = (r: string) => (r === '' ? [] : stripLineNumberPrefixes(r).split(/\r?\n/));
    const isAnchor = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;

    const anchored: Array<{ start: number; searchLines: string[]; replace: string }> = [];
    const fallback: EditPatch[] = [];
    for (const patch of patches) {
        if (isAnchor(patch.start_line)) {
            anchored.push({ start: patch.start_line, searchLines: searchLinesOf(patch.search), replace: patch.replace });
        } else {
            fallback.push(patch);
        }
    }

    // Anchored: bottom-up so a splice never invalidates an earlier (smaller) anchor.
    anchored.sort((a, b) => b.start - a.start);
    for (const { start, searchLines, replace } of anchored) {
        const idx = start - 1;
        const inRange = idx >= 0 && idx + searchLines.length <= lines.length;
        const matches = inRange && searchLines.every((s, i) => sameLine(lines[idx + i], s));
        if (matches) {
            lines.splice(idx, searchLines.length, ...replaceLinesOf(replace));
        } else {
            warn(`line ${start} no longer matches the tutor's expected content — edit skipped (re-load the file and try again)`);
        }
    }

    // Fallback (no usable start_line): apply ONLY on a unique full-line match.
    for (const { search, replace } of fallback) {
        const searchLines = searchLinesOf(search);
        const hits: number[] = [];
        for (let i = 0; i + searchLines.length <= lines.length; i++) {
            if (searchLines.every((s, j) => sameLine(lines[i + j], s))) hits.push(i);
        }
        if (hits.length === 1) {
            lines.splice(hits[0], searchLines.length, ...replaceLinesOf(replace));
        } else if (hits.length === 0) {
            warn(`patch search text not found, skipped`);
        } else {
            warn(`patch search text is ambiguous (${hits.length} matches) and has no line anchor — skipped`);
        }
    }

    return lines.join(eol);
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

    async execute(instruction: string, history: SessionMessage[], sessionTurns?: SessionTurn[]): Promise<TutorResult> {
        // Backend owns guard + prompt composition + LLM call. callGateway() guards against missing gateways.
        return this.callGateway(instruction, history, sessionTurns);
    }

    // ── Option B orchestration ────────────────────────────────────────────────

    private async callGateway(instruction: string, history: SessionMessage[], sessionTurns?: SessionTurn[]): Promise<TutorResult> {
        // ── 1. workspace_overview + file_context (reuses scan + read helpers) ──
        // Single budget instance for the whole turn: base reads and B3 continuation
        // loads draw from one shared pool (gap-list §C, b3 §2.3). The scan summary
        // travels in the separate `workspace_overview` channel (plan 2026-06-12 §4);
        // @-mentioned files are loaded here and seeded into the dedup set so a
        // backend load_file for the same path is immediately a no-op.
        const budget = new FileContextBudget(PER_TURN_FILE_CONTEXT_TOKEN_CAP);
        const { workspaceOverview, mentionResolutions } = await this.buildContext(instruction, budget);

        // Seed the dedup map + loadedBlocks with @-mention files BEFORE the loop
        // (plan 2026-06-13 §5.1 C): when the backend returns `load_file hw2.R` for
        // a file already in file_context, resolved.has() fires → madeProgress stays
        // false → the continuation loop terminates without a redundant API call.
        const resolved = new Map<string, 'loaded' | 'unavailable'>();
        const loadedBlocks: string[] = [];
        for (const r of mentionResolutions) {
            resolved.set(r.key, r.ok ? 'loaded' : 'unavailable');
            loadedBlocks.push(r.block);
        }

        // ── 2. Guard pre-call ──────────────────────────────────────────────────
        this.deps.emit('phase_start', { phase: 'guard', description: 'Running safety check' });
        let guard;
        try {
            guard = await this.deps.guardCheckGateway.check(instruction);
        } catch (error) {
            return this.failTutor('guard', error);
        }
        this.deps.emit('phase_end', { phase: 'guard', success: true });

        const apiLogs: ApiLogEntry[] = [];
        if (guard.rawExchange) {
            apiLogs.push(
                { timestamp: guard.rawExchange.requestAt,  source: 'guard', direction: 'request',  payload: guard.rawExchange.requestBody  },
                { timestamp: guard.rawExchange.responseAt, source: 'guard', direction: 'response', payload: guard.rawExchange.responseBody },
            );
        }

        if (guard.status === 'forbidden') {
            this.deps.emit('guard_blocked', { reason: 'content_policy', phase: 'guard' });
            this.deps.emit('text_output', { content: guard.refusal });
            return { content: guard.refusal, usage: toTurnUsage(guard.usage), apiLogs };
        }
        if (guard.status === 'error') {
            // decision doc §3.1: no log_id produced → cannot proceed. Show + retry.
            this.deps.emit('error', { message: `Safety check failed: ${guard.message}. Please try again.`, phase: 'guard' });
            return { content: '', usage: toTurnUsage(guard.usage), apiLogs };
        }
        if (guard.guardSkipped) {
            this.deps.emit('status_update', { warning: 'guard skipped: llm unavailable' });
        }

        // ── 3. B3 continuation loop (G1+G4+G5+G6+G9) ─────────────────────────
        const emittedWarnings = new Set<string>();
        let usage = toTurnUsage(guard.usage);

        for (let i = 0; ; i++) {
            // file_context is a flat sequence of `### <path>` blocks (plan 2026-06-14 §C).
            // No `## ` section headings — they become sibling nodes to the backend's
            // `## Student Workspace (live)` heading, making that section appear empty
            // and causing the model to re-issue load_file for already-loaded files.
            const fileContext = loadedBlocks.join('');

            this.deps.emit('phase_start', { phase: 'tutor', description: i === 0 ? 'Calling tutor API' : `Continuation ${i}` });
            let result;
            try {
                result = await this.deps.tutorChatGateway.send(
                    instruction, history, guard.logId,
                    fileContext || undefined,
                    workspaceOverview || undefined,
                    sessionTurns,
                );
            } catch (error) {
                return this.failTutor('tutor', error);
            }

            // Hard 429 (plan 2026-06-18 §6, C): back off & retry — never "open a new
            // conversation" (that is the OPPOSITE action, reserved for session_limit_reached).
            // Handled here, before usage/rawExchange are read, because the rate_limited
            // variant carries neither field; narrowing it out keeps the accesses below valid.
            // Uses the existing `error` event (no new event type) and does NOT retry.
            if (result.status === 'rate_limited') {
                const waitMsg = result.retryAfterSeconds != null
                    ? `Please wait about ${result.retryAfterSeconds} seconds before retrying.`
                    : 'Please wait a moment before retrying.';
                const scopeMsg = result.limitDimension === 'requests'
                    ? 'Your API key has hit its per-minute request limit.'
                    : result.limitDimension === 'tokens'
                        ? 'Your API key has hit its per-minute token limit.'
                        : 'Your API key has been rate limited by the LLM provider.';
                this.deps.emit('phase_end', { phase: 'tutor', success: false });
                this.deps.emit('error', { message: `${scopeMsg} ${waitMsg}`, phase: 'tutor' });
                return { content: '', usage, apiLogs };
            }

            // Hard 413 (plan 2026-06-24 D): input exceeds the provider's per-request token
            // cap. Guide the student to start a new conversation — DO NOT retry (same body
            // always re-triggers 413). OPPOSITE action from 429 (back-off & retry).
            if (result.status === 'input_too_large') {
                const limitMsg = result.maxInputTokens != null
                    ? `This input is too long for the provider (limit: ${result.maxInputTokens} tokens). Please start a new conversation.`
                    : 'This input is too long for the provider. Please start a new conversation.';
                this.deps.emit('phase_end', { phase: 'tutor', success: false });
                this.deps.emit('error', { message: limitMsg, phase: 'tutor' });
                return { content: '', usage, apiLogs };
            }

            usage = addUsage(usage, toTurnUsage(result.usage));

            if (result.rawExchange) {
                apiLogs.push(
                    { timestamp: result.rawExchange.requestAt,  source: 'tutor', direction: 'request',  payload: result.rawExchange.requestBody  },
                    { timestamp: result.rawExchange.responseAt, source: 'tutor', direction: 'response', payload: result.rawExchange.responseBody },
                );
            }

            if (result.status === 'forbidden') {
                this.deps.emit('guard_blocked', { reason: 'guard_credential', phase: 'tutor' });
                this.deps.emit('text_output', { content: result.content });
                this.deps.emit('phase_end', { phase: 'tutor', success: true });
                return { content: result.content, usage, apiLogs };
            }
            if (result.status === 'error') {
                this.deps.emit('phase_end', { phase: 'tutor', success: false });
                this.deps.emit('error', { message: `Tutor call failed: ${result.content || 'unknown error'}. Please try again.`, phase: 'tutor' });
                return { content: result.content, usage, apiLogs };
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
            return { content: result.content, usage, apiLogs };
        }
    }

    private failTutor(phase: 'guard' | 'tutor', error: unknown): never {
        this.deps.emit('phase_end', { phase, success: false });
        this.deps.emit('error', { message: this.describeError(error), phase });
        throw error;
    }

    /**
     * The gateways already fold the backend's error body into the thrown Error's message
     * (gateway §3.2), so for those the `instanceof Error` branch already carries detail.
     * The isAxiosError branch is a defensive fallback for any AxiosError that reaches here
     * un-wrapped — it surfaces the backend `response.data` instead of the generic axios
     * "Request failed with status code 400" that hides why the request was rejected.
     */
    private describeError(error: unknown): string {
        if (isAxiosError(error) && error.response) {
            const detail = typeof error.response.data === 'string'
                ? error.response.data
                : JSON.stringify(error.response.data);
            return `${error.response.status}: ${detail}`;
        }
        return error instanceof Error ? error.message : String(error);
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

        const proposed = applyAnchoredPatches(original, action.patches,
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

    // ── workspace_overview + file_context assembly (Option B) ─────────────────

    private async buildContext(
        instruction: string,
        budget: FileContextBudget,
    ): Promise<{ workspaceOverview: string; mentionResolutions: LoadResolution[] }> {
        this.deps.emit('phase_start', { phase: 'scan', description: 'Building file context' });
        // file_scan stays unconditional but name-only (decision 1): the cheap
        // scan summary is what lets the B3 load_file loop know which workspace
        // files it can request. Content reads are @-gated below.
        const { projectContext, scannedFiles } = await this.buildProjectContext();
        const mentionResolutions = await this.readMentionedFiles(instruction, scannedFiles, budget);
        this.deps.emit('phase_end', { phase: 'scan', success: true });

        return {
            // Cheap manifest (no contents/line numbers) → `workspace_overview`. The
            // backend renders it under `## Student Workspace (overview)` + the
            // load-file guide and never appends a line-number guide for it.
            workspaceOverview: projectContext,
            // Numbered contents of @-mentioned files, as LoadResolution objects so
            // callGateway can seed the dedup map before the continuation loop starts.
            mentionResolutions,
        };
    }

    /**
     * @-gated content reads (plan 2026-06-11 §2.4): only files the student
     * explicitly names with `@<file>` are loaded. Each token is matched against
     * the file_scan results by basename (case-insensitive); an unmatched token
     * is handed to the loader as a relative path (confinement blocks escapes),
     * so a miss yields an unavailable marker + warning — visible to both the
     * LLM and the student, never a silent drop.
     *
     * Returns LoadResolution[] so callGateway can seed the dedup map before the
     * continuation loop (plan 2026-06-13 §5.1 C).
     */
    private async readMentionedFiles(
        instruction: string,
        scannedFiles: ScannedFile[],
        budget: FileContextBudget,
    ): Promise<LoadResolution[]> {
        const tokens = [...instruction.matchAll(FILE_MENTION_RE)].map(m => m[1]);
        if (tokens.length === 0) return [];

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
     * Read a fixed set of files through ContinuationFileLoader.resolve(), collecting
     * LoadResolution objects under the shared per-turn token budget; once the pool is
     * spent the remaining files are refused with a visible marker rather than silently
     * dropped. PDF, binary, and symlink-escape checks are all handled inside the loader.
     *
     * Returns LoadResolution[] (not a concatenated string) so callers can seed the
     * dedup map keyed by canonical path (plan 2026-06-13 §5.1 C).
     */
    private async readFiles(
        targets: Array<{ name: string; path: string }>,
        budget: FileContextBudget,
    ): Promise<LoadResolution[]> {
        const results: LoadResolution[] = [];
        for (const file of targets) {
            if (budget.isExhausted()) {
                // Early exit: skip PathConfinement + FS read when nothing fits anyway.
                // Use the best-effort abs path as dedup key — matches the canonical path
                // the loader would produce for non-symlinked files.
                const bestKey = path.isAbsolute(file.path)
                    ? file.path
                    : path.resolve(this.deps.directory, file.path);
                results.push({ key: bestKey, ok: false, block: budget.skipMarker(file.name) });
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
                results.push(resolution);
                if (!resolution.ok) {
                    this.deps.emit('status_update', { warning: `Could not load ${file.name} for context` });
                }
            } catch (error) {
                this.deps.emit('status_update', {
                    warning: `Could not read file ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }
        return results;
    }
}
