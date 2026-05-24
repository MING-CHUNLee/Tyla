/**
 * Centralized persistence paths.
 *
 * Project-scoped data (sessions, knowledge, commands) lives in <cwd>/.tyla/
 * Global data (plugins, login profile) stays in ~/.tyla/
 */

import path from 'path';
import fs from 'fs';

export function getProjectBase(): string {
    const dir = path.join(process.cwd(), '.tyla');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
        // Bun on Windows throws EEXIST even with recursive:true when the dir
        // already exists — swallow it; the directory is there either way.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return dir;
}

export function getSessionsDir(): string {
    return path.join(getProjectBase(), 'sessions');
}

export function getLastSessionFile(): string {
    return path.join(getProjectBase(), 'last-session');
}

export function getKnowledgeFile(): string {
    return path.join(getProjectBase(), 'knowledge.json');
}

export function getCommandsDir(): string {
    return path.join(getProjectBase(), 'commands');
}

export function getSettingsFile(): string {
    return path.join(getProjectBase(), 'settings.json');
}

export function getGuardLogFile(): string {
    return path.join(getProjectBase(), 'guard-log.json');
}

export function getProfileFile(baseDir?: string): string {
    const dir = baseDir ?? process.cwd();
    return path.join(dir, '.tyla', 'profile.json');
}
