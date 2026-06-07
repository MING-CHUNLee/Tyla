/**
 * Service: FileReadService
 *
 * Encapsulates all fs I/O and domain guards for reading a file.
 * Returns a discriminated union so callers never touch the filesystem directly.
 *
 * Path resolution is delegated to the shared PathConfinement primitive, which
 * anchors every read to the workspace `root` (not `process.cwd()`) and rejects
 * any request that escapes it via `..`, an absolute path, or a symlink. This
 * service then layers its own budget policy on top — the 100k-char cap for
 * ask / ReAct reads — which is deliberately separate from the security policy.
 */

import { IFileSystem } from '../../domain/types/file-system';
import { isContentEditable } from '../../domain/policies/agent-file-policy';
import { PathConfinement } from '../../domain/policies/path-confinement';

export type FileReadResult =
    | { content: string; absPath: string }
    | { error: string };

export class FileReadService {
    private readonly confinement: PathConfinement;

    constructor(
        private readonly fileSystem: IFileSystem,
        private readonly root: string,
        confinement?: PathConfinement,
    ) {
        this.confinement = confinement ?? new PathConfinement(fileSystem);
    }

    read(filePath: string): FileReadResult {
        const confined = this.confinement.resolveWithinRoot(this.root, filePath);
        if (!confined.ok) {
            return { error: confined.message };
        }
        const absPath = confined.canonicalPath;

        let content: string;
        try {
            content = this.fileSystem.read(absPath);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { error: `Failed to read file: ${msg}` };
        }

        const sizeCheck = isContentEditable(absPath, content);
        if (!sizeCheck.ok) {
            return { error: `File too large to read: ${sizeCheck.reason}` };
        }

        return { content, absPath };
    }
}
