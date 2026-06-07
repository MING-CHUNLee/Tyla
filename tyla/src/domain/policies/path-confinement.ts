/**
 * Domain Policy: PathConfinement
 *
 * The single security primitive that confines a requested path to a workspace
 * root. Every read path (ask / ReAct `file_read`, and — later — the B3
 * continuation driver) shares this one boundary so confinement behaviour can
 * never diverge between callers.
 *
 * It does NOT read files and does NOT apply any size/token cap. Boundary +
 * realpath only. Callers layer their own (deliberately different) budget policy
 * on top: ask/ReAct keep a 100k-char cap, B3 will use a token cap. Keeping the
 * *security* policy (this primitive) separate from the *budget* policy (each
 * caller) is the point of the design.
 *
 * Depends on the injected IFileSystem (for `realpath`) so it can be unit-tested
 * with a mock fs and so only LocalFileSystem ever touches Node's `fs`.
 */

import path from 'path';
import { IFileSystem } from '../types/file-system';

/**
 * Stable, machine-readable failure codes. Callers branch on these — never on
 * the human-readable `message` (which interpolates the request and is cosmetic).
 *
 *   empty            — blank request
 *   absolute         — request was an absolute path (posix /, drive-letter, UNC, \\?\)
 *   root-unavailable — the workspace root could not be canonicalized (realpath threw)
 *   not-found        — the target does not exist or is a broken symlink (realpath threw)
 *   escape           — the canonical target resolved outside the root
 */
export type ConfinementFailureReason =
    | 'empty'
    | 'absolute'
    | 'root-unavailable'
    | 'not-found'
    | 'escape';

export type ConfinementResult =
    | { ok: true; canonicalPath: string }
    | { ok: false; reason: ConfinementFailureReason; message: string };

export class PathConfinement {
    constructor(private readonly fileSystem: IFileSystem) {}

    /**
     * Resolves `requested` against `root` and confirms the canonical target
     * stays inside `root` after symlinks are followed.
     *
     * Steps: reject absolute `requested` → realpath(root) → resolve(root,
     * requested) → realpath(target) → path.relative(root, target). Confinement
     * is decided by the *relative* path (rejecting `..`/absolute), never by
     * string-matching the raw input — that is the only escape-proof check.
     */
    resolveWithinRoot(root: string, requested: string): ConfinementResult {
        const trimmed = requested.trim();
        if (!trimmed) {
            return fail('empty', 'No file path provided.');
        }

        // Reject any absolute form before touching the fs. Check both posix and
        // win32 so a Windows path (drive-letter `C:\`, UNC `\\server\share`,
        // extended-length `\\?\`) is blocked even when running on posix, and a
        // posix-absolute `/etc/...` is blocked even on Windows.
        if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
            return fail(
                'absolute',
                `Absolute paths are not allowed: "${requested}". Use a path relative to the workspace root.`,
            );
        }

        // Canonicalize the root itself (it may be a symlink, e.g. macOS /var).
        let canonicalRoot: string;
        try {
            canonicalRoot = this.fileSystem.realpath(root);
        } catch {
            return fail('root-unavailable', `Workspace root is unavailable: ${root}`);
        }

        const target = path.resolve(canonicalRoot, trimmed);

        // realpath follows symlinks and throws on a missing (or broken-symlink)
        // target — both collapse to the same "not found" outcome here.
        let canonicalTarget: string;
        try {
            canonicalTarget = this.fileSystem.realpath(target);
        } catch {
            return fail('not-found', `File not found or unavailable: ${requested}`);
        }

        const rel = path.relative(canonicalRoot, canonicalTarget);
        const escapesRoot =
            rel === '..' ||
            rel.startsWith(`..${path.sep}`) ||
            rel.startsWith('../') || // posix separator, defence-in-depth
            path.isAbsolute(rel);    // different drive on Windows → absolute rel
        if (escapesRoot) {
            return fail('escape', `Path escapes the workspace root: ${requested}`);
        }

        return { ok: true, canonicalPath: canonicalTarget };
    }
}

function fail(reason: ConfinementFailureReason, message: string): ConfinementResult {
    return { ok: false, reason, message };
}
