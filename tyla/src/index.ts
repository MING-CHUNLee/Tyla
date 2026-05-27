#!/usr/bin/env node

/**
 * Tyla RStudio CLI — Entry Dispatcher
 *
 * Pure dispatcher: decides whether to launch TUI or CLI and delegates.
 *
 *   tyla                             → Interactive TUI REPL
 *   tyla --assignment <path>         → TUI in tutor-guide mode for assignment
 *   tyla agent "..."                 → CLI agent mode
 *   tyla ask "..."                   → CLI ask mode
 *   tyla agent rollback [n]          → Rollback session
 */

import fs from 'fs';
import path from 'path';

function resolveAssignmentDir(value: string): string {
    const candidate = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
    if (!fs.existsSync(candidate)) {
        throw new Error(
            `Assignment directory not found: ${candidate}\n` +
            `  Pass an absolute path or a path relative to the current directory.\n` +
            `  Example: --assignment tests/fixtures/assignments/CSDS-HW2`,
        );
    }
    return candidate;
}

(async () => {
    const args = process.argv.slice(2);
    const assignmentIdx = args.indexOf('--assignment');
    const hasAssignment = assignmentIdx !== -1;
    const hasTutor = args.includes('--tutor');
    const isTUI = args.length === 0 || hasAssignment || hasTutor;

    if (isTUI) {
        let assignmentDir: string | undefined;
        if (hasAssignment) {
            const value = args[assignmentIdx + 1];
            if (!value || value.startsWith('-')) {
                process.stderr.write('Error: --assignment requires a path argument\n');
                process.exit(1);
            }
            assignmentDir = resolveAssignmentDir(value);
        }

        // Dynamic import via Function prevents tsc from type-checking the ESM TUI module
        // (ink requires node16 moduleResolution; the TUI dir is excluded from CJS compilation)
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const load = new Function('p', 'return import(p)') as (p: string) => Promise<{ startTUI: (cfg?: { directory: string; assignmentDir?: string; tutorMode?: boolean }) => Promise<void> }>;
        const { startTUI } = await load('./tui/index.js');
        await startTUI({ directory: process.env['INIT_CWD'] ?? process.cwd(), assignmentDir, tutorMode: hasTutor });
    } else {
        const { startCLI } = await import('./cli/index');
        await startCLI();
    }
})();
