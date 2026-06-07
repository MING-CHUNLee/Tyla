/**
 * Unit Tests: LocalFileSystem.realpath
 *
 * realpath is the security primitive that path-confinement (gap A) depends on:
 * it must canonicalize a path and follow symlinks so a request cannot escape
 * the workspace root via a symlink or `..` segments. These tests exercise the
 * real fs (LocalFileSystem is the one place allowed to touch `fs`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalFileSystem } from '../../../src/infrastructure/filesystem/local-file-system';

// Probe symlink support once: on Windows without Developer Mode / admin,
// symlinkSync throws EPERM, so the symlink case is skipped rather than failed.
function symlinksSupported(dir: string): boolean {
    const target = path.join(dir, '.probe-target');
    const link = path.join(dir, '.probe-link');
    try {
        fs.writeFileSync(target, 'x');
        fs.symlinkSync(target, link);
        return true;
    } catch {
        return false;
    } finally {
        try { fs.rmSync(link, { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
    }
}

describe('LocalFileSystem.realpath', () => {
    const lfs = new LocalFileSystem();
    let dir: string;        // mkdtemp dir (may itself be a symlink, e.g. macOS /var)
    let canonicalDir: string;
    let canSymlink = false;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-realpath-'));
        canonicalDir = fs.realpathSync(dir);
        canSymlink = symlinksSupported(dir);
    });

    afterAll(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('returns the canonical absolute path of an existing file', () => {
        const file = path.join(dir, 'hw.R');
        fs.writeFileSync(file, 'x <- 1\n');

        const resolved = lfs.realpath(file);

        expect(path.isAbsolute(resolved)).toBe(true);
        expect(resolved).toBe(path.join(canonicalDir, 'hw.R'));
    });

    it('normalizes `.` and `..` segments to the same canonical path', () => {
        const file = path.join(dir, 'data.csv');
        fs.writeFileSync(file, 'a,b\n');
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });

        // Build a non-normalized string that walks through the real `sub` dir
        // and back out, so fs (not path.join) must collapse it.
        const messy = ['.', 'sub', '..', 'data.csv'].join(path.sep);
        const requested = path.join(dir) + path.sep + messy;

        expect(lfs.realpath(requested)).toBe(path.join(canonicalDir, 'data.csv'));
    });

    it('follows symlinks to the link target (escape-detection primitive)', () => {
        if (!canSymlink) {
            // Skip on platforms without symlink privilege; behavior is delegated
            // to fs.realpathSync, which is covered on supporting platforms.
            return;
        }
        const target = path.join(dir, 'real.txt');
        const link = path.join(dir, 'alias.txt');
        fs.writeFileSync(target, 'secret\n');
        fs.symlinkSync(target, link);

        expect(lfs.realpath(link)).toBe(path.join(canonicalDir, 'real.txt'));
        expect(lfs.realpath(link)).toBe(lfs.realpath(target));
    });

    it('throws when the path does not exist (treated as unavailable)', () => {
        const missing = path.join(dir, 'does-not-exist.R');
        expect(() => lfs.realpath(missing)).toThrow();
    });

    it('throws on a broken symlink whose target is missing', () => {
        if (!canSymlink) return;
        const link = path.join(dir, 'dangling.txt');
        fs.symlinkSync(path.join(dir, 'no-such-target.txt'), link);

        expect(() => lfs.realpath(link)).toThrow();
    });
});
