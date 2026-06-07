/**
 * Domain Interface: IFileSystem
 *
 * Contract for all file-system I/O operations.
 * Tools and services depend on this interface, never on Node's `fs` module directly.
 * Infrastructure layer provides the concrete implementation (LocalFileSystem).
 */

export interface IFileSystem {
    /** Returns true if the path exists (file or directory). */
    exists(filePath: string): boolean;

    /** Reads the file at filePath as UTF-8 text. Throws on error. */
    read(filePath: string): string;

    /** Reads the file at filePath as a raw Buffer. Throws on error. */
    readBuffer(filePath: string): Buffer;

    /**
     * Writes content to filePath as UTF-8 text.
     * Creates the file if it does not exist; overwrites it if it does.
     */
    write(filePath: string, content: string): void;

    /**
     * Ensures the directory at dirPath exists, creating all intermediate
     * directories as needed. Equivalent to `mkdir -p`.
     */
    mkdir(dirPath: string): void;

    /** Returns basic metadata for a file or directory. Throws if path does not exist. */
    stat(filePath: string): FileStats;

    /**
     * Resolves filePath to its canonical absolute path, following symlinks and
     * normalizing `.`/`..` segments. Throws if the path (or any symlink target
     * along it) does not exist.
     */
    realpath(filePath: string): string;
}

export interface FileStats {
    size: number;
    modifiedAt: Date;
    isDirectory: boolean;
}
