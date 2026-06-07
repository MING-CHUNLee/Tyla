/**
 * Unit Tests: PathConfinement.resolveWithinRoot
 *
 * The shared security primitive (gap A). It must:
 *   - accept relative paths inside the root (hw.R, ./hw.R → same canonical),
 *   - reject absolute paths (posix /, Windows drive-letter, UNC, \\?\),
 *   - reject `..` escapes and symlink escapes,
 *   - converge hw.R / ./hw.R / a symlink to the same canonical path.
 *
 * Filesystem-backed cases use the real LocalFileSystem (realpath needs real
 * inodes to follow symlinks); the absolute-rejection cases short-circuit before
 * any fs call, so they run cross-platform regardless of the host OS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalFileSystem } from '../../../src/infrastructure/filesystem/local-file-system';
import { PathConfinement } from '../../../src/domain/policies/path-confinement';

// Probe symlink support once: on Windows without Developer Mode / admin,
// symlinkSync throws EPERM, so symlink cases are skipped rather than failed.
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

describe('PathConfinement.resolveWithinRoot', () => {
    const confinement = new PathConfinement(new LocalFileSystem());

    let root: string;          // workspace root (a mkdtemp dir)
    let canonicalRoot: string; // root after realpath (mkdtemp may be a symlink)
    let outsideDir: string;    // sibling dir used for escape tests
    let canonicalOutside: string;
    let canSymlink = false;

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-root-'));
        canonicalRoot = fs.realpathSync(root);
        outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-out-'));
        canonicalOutside = fs.realpathSync(outsideDir);
        canSymlink = symlinksSupported(root);

        fs.writeFileSync(path.join(root, 'hw.R'), 'x <- 1\n');
        fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(root, 'sub', 'nested.R'), 'y <- 2\n');
        fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret\n');
    });

    afterAll(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ── Relative OK ─────────────────────────────────────────────────────────
    it('accepts a relative path inside the root', () => {
        const r = confinement.resolveWithinRoot(root, 'hw.R');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.canonicalPath).toBe(path.join(canonicalRoot, 'hw.R'));
    });

    it('accepts a nested relative path inside the root', () => {
        const r = confinement.resolveWithinRoot(root, path.join('sub', 'nested.R'));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.canonicalPath).toBe(path.join(canonicalRoot, 'sub', 'nested.R'));
    });

    // ── realpath convergence: hw.R / ./hw.R → same canonical ────────────────
    it('resolves hw.R and ./hw.R to the same canonical path', () => {
        const a = confinement.resolveWithinRoot(root, 'hw.R');
        const b = confinement.resolveWithinRoot(root, './hw.R');
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) expect(a.canonicalPath).toBe(b.canonicalPath);
    });

    it('collapses messy `.`/`..` segments that stay inside the root', () => {
        const messy = ['.', 'sub', '..', 'hw.R'].join(path.sep);
        const r = confinement.resolveWithinRoot(root, messy);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.canonicalPath).toBe(path.join(canonicalRoot, 'hw.R'));
    });

    // ── Absolute rejected (with stable 'absolute' code) ─────────────────────
    it('rejects an absolute posix path', () => {
        const r = confinement.resolveWithinRoot(root, '/etc/passwd');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('absolute');
    });

    it('rejects a Windows drive-letter absolute path', () => {
        const r = confinement.resolveWithinRoot(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('absolute');
    });

    it('rejects a UNC path', () => {
        const r = confinement.resolveWithinRoot(root, '\\\\server\\share\\secret.txt');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('absolute');
    });

    it('rejects an extended-length \\\\?\\ path', () => {
        const r = confinement.resolveWithinRoot(root, '\\\\?\\C:\\secret.txt');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('absolute');
    });

    // ── `..` escape rejected (with stable 'escape' code) ────────────────────
    it('rejects a relative path that escapes the root via ..', () => {
        const rel = path.relative(canonicalRoot, path.join(canonicalOutside, 'secret.txt'));
        // sanity: this really is an escaping relative path
        expect(rel.startsWith('..')).toBe(true);
        const r = confinement.resolveWithinRoot(root, rel);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('escape');
    });

    // ── symlink escape rejected ─────────────────────────────────────────────
    it('rejects a symlink inside the root that points outside it', () => {
        if (!canSymlink) return;
        const link = path.join(root, 'escape-link.txt');
        fs.symlinkSync(path.join(outsideDir, 'secret.txt'), link);
        try {
            const r = confinement.resolveWithinRoot(root, 'escape-link.txt');
            expect(r.ok).toBe(false);
            // realpath follows the link out of root → 'escape', not 'not-found'.
            if (!r.ok) expect(r.reason).toBe('escape');
        } finally {
            fs.rmSync(link, { force: true });
        }
    });

    // ── symlink inside root → converges to canonical target ─────────────────
    it('resolves an in-root symlink to the same canonical path as its target', () => {
        if (!canSymlink) return;
        const link = path.join(root, 'alias.R');
        fs.symlinkSync(path.join(root, 'hw.R'), link);
        try {
            const viaLink = confinement.resolveWithinRoot(root, 'alias.R');
            const direct = confinement.resolveWithinRoot(root, 'hw.R');
            expect(viaLink.ok && direct.ok).toBe(true);
            if (viaLink.ok && direct.ok) {
                expect(viaLink.canonicalPath).toBe(direct.canonicalPath);
            }
        } finally {
            fs.rmSync(link, { force: true });
        }
    });

    // ── Unavailable / empty (stable 'not-found' / 'empty' codes) ────────────
    it('rejects a path that does not exist', () => {
        const r = confinement.resolveWithinRoot(root, 'does-not-exist.R');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('not-found');
    });

    it('rejects an empty request', () => {
        const r = confinement.resolveWithinRoot(root, '   ');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('empty');
    });
});

// A mock IFileSystem proves the primitive is fs-injectable (no real `fs`),
// which is what lets the boundary logic be unit-tested deterministically.
describe('PathConfinement with an injected mock fs', () => {
    function mockFs(realpath: (p: string) => string): import('../../../src/domain/types/file-system').IFileSystem {
        return {
            exists: () => true,
            read: () => '',
            readBuffer: () => Buffer.from(''),
            write: () => {},
            mkdir: () => {},
            stat: () => ({ size: 0, modifiedAt: new Date(), isDirectory: false }),
            realpath,
        };
    }

    it('uses the injected realpath and accepts an in-root target', () => {
        // Identity realpath (no symlinks): canonicalization is just path.resolve.
        const confinement = new PathConfinement(mockFs((p) => p));
        const rootDir = path.resolve('proj');
        const r = confinement.resolveWithinRoot(rootDir, 'hw.R');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.canonicalPath).toBe(path.join(rootDir, 'hw.R'));
    });

    it('rejects when the injected realpath resolves the target outside the root (symlink escape)', () => {
        const rootDir = path.resolve('proj');
        const escaped = path.resolve('elsewhere', 'secret.txt');
        // realpath redirects the in-root link to a path outside the root.
        const confinement = new PathConfinement(
            mockFs((p) => (p === path.join(rootDir, 'link.txt') ? escaped : p)),
        );
        const r = confinement.resolveWithinRoot(rootDir, 'link.txt');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('escape');
    });

    it('reports root-unavailable when realpath(root) throws', () => {
        const rootDir = path.resolve('proj');
        // Only the root canonicalization throws; the target would be fine.
        const confinement = new PathConfinement(
            mockFs((p) => { if (p === rootDir) throw new Error('ENOENT'); return p; }),
        );
        const r = confinement.resolveWithinRoot(rootDir, 'hw.R');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('root-unavailable');
    });

    it('reports not-found when realpath(target) throws', () => {
        const rootDir = path.resolve('proj');
        // Root canonicalizes fine; only the target is missing.
        const confinement = new PathConfinement(
            mockFs((p) => { if (p !== rootDir) throw new Error('ENOENT'); return p; }),
        );
        const r = confinement.resolveWithinRoot(rootDir, 'hw.R');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('not-found');
    });
});
