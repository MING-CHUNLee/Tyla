/**
 * Service: EditStagingService
 *
 * Owns the staging queue for proposed file edits.  Shared between two callers:
 *   - FileEditTool (ReAct tool layer) — stages individual edits during the loop
 *   - ExecuteInstructionUseCase — drains the queue, builds artifact edits,
 *     and applies approved edits after the human-in-the-loop gate.
 *
 * The single shared instance is the conduit between what the tool stages and
 * what the use case later drains, reviews, and applies.
 */

import path from 'path';
import { IFileSystem } from '../../domain/types/file-system';
import { DiffEngine, DiffLine } from './diff-engine';

/** Type guard: true when e is a Node.js system error with a `.code` property. */
function isNodeError(e: unknown): e is NodeJS.ErrnoException {
    return e instanceof Error && 'code' in e;
}

export interface StagedEdit {
    path: string;      // relative path as given by the LLM (shown in the diff header)
    content: string;   // proposed new content
    original: string;  // content that was on disk at staging time ('' for new files)
    diff: string;      // coloured diff string for CLI display (chalk ANSI)
    diffLines: DiffLine[];  // structured diff for TUI Ink rendering
    absPath?: string;  // set by stageOnly(): resolved target for applyEdit (tutor uses a base dir ≠ cwd)
}

type EmitFn = (type: string, data: Record<string, unknown>) => void;

export class EditStagingService {
    private readonly _staged: StagedEdit[] = [];

    constructor(
        private readonly fileSystem: IFileSystem,
        private readonly diffEngine: DiffEngine,
    ) {}

    /**
     * Read the current file, compute a diff against the proposed content, and push
     * the result to the staging queue.
     *
     * Returns `{ staged }` on success, or `{ error, isHardError }` on failure.
     * `isHardError: false` means the error is informational (e.g. no changes).
     */
    stage(filePath: string, content: string): { staged: StagedEdit } | { error: string; isHardError: boolean } {
        const absPath = path.resolve(filePath);
        const exists = this.fileSystem.exists(absPath);

        let original = '';
        if (exists) {
            try {
                original = this.fileSystem.read(absPath);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { error: `Cannot read ${path.basename(absPath)}: ${msg}`, isHardError: true };
            }
        }

        if (original === content) {
            return {
                error: `No changes detected in ${path.basename(absPath)} — file already matches proposed content.`,
                isHardError: false,
            };
        }

        const diffLines = this.diffEngine.generateDiffLines(original, content);
        const diff = this.diffEngine.generateColoredDiff(original, content);
        const staged: StagedEdit = { path: filePath, content, original, diff, diffLines };
        this._staged.push(staged);
        return { staged };
    }

    /**
     * Like stage(), but (a) does NOT push to the drain queue — for callers that apply
     * per-edit (the tutor dispatch), and (b) resolves `relPath` against `baseDir` (not cwd)
     * for read/diff/apply while keeping `relPath` for display.
     */
    stageOnly(relPath: string, content: string, baseDir: string):
        { staged: StagedEdit } | { error: string; isHardError: boolean } {
        const absPath = path.resolve(baseDir, relPath);
        const exists  = this.fileSystem.exists(absPath);

        let original = '';
        if (exists) {
            try {
                original = this.fileSystem.read(absPath);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { error: `Cannot read ${path.basename(absPath)}: ${msg}`, isHardError: true };
            }
        }
        if (original === content) {
            return { error: `No changes detected in ${path.basename(absPath)}.`, isHardError: false };
        }

        const diffLines = this.diffEngine.generateDiffLines(original, content);
        const diff = this.diffEngine.generateColoredDiff(original, content);
        return { staged: { path: relPath, content, original, diff, diffLines, absPath } };   // not pushed
    }

    /**
     * Convert artifact-extracted edits (from LLM JSON blob) into StagedEdit objects
     * by reading the original file and computing the diff.
     * Skips edits where the proposed content is identical to the current file.
     */
    stageFromArtifacts(
        artifacts: Array<{ path: string; content: string }>,
        directory: string,
        emit: EmitFn,
    ): StagedEdit[] {
        const staged: StagedEdit[] = [];
        for (const artifact of artifacts) {
            const absPath = path.resolve(directory, artifact.path);
            let original = '';
            try {
                original = this.fileSystem.read(absPath);
            } catch (error) {
                if (!isNodeError(error) || error.code !== 'ENOENT') {
                    emit('error', {
                        message: `Cannot read ${absPath}: ${error instanceof Error ? error.message : String(error)}`,
                        phase: 'review',
                    });
                    continue;
                }
                // ENOENT = new file being created — original stays ''
            }

            if (original === artifact.content) continue;

            staged.push({
                path: artifact.path,
                content: artifact.content,
                original,
                diff: this.diffEngine.generateColoredDiff(original, artifact.content),
                diffLines: this.diffEngine.generateDiffLines(original, artifact.content),
            });
        }
        return staged;
    }

    /**
     * Retrieve and clear all staged edits.
     * Called once by the use case after the ReAct loop completes.
     */
    drainStagedEdits(): StagedEdit[] {
        return this._staged.splice(0);
    }

    /**
     * Write an approved edit to disk — the only place fs.write lives in this service.
     * Called by the use case for each edit the user accepts.
     */
    applyEdit(edit: StagedEdit): void {
        const absPath = edit.absPath ?? path.resolve(edit.path);
        this.fileSystem.mkdir(path.dirname(absPath));
        this.fileSystem.write(absPath, edit.content);
    }
}
