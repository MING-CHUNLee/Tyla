/**
 * User settings loader.
 *
 * Reads <cwd>/.tyla/settings.json for user preferences.
 * Returns sensible defaults when the file is missing or invalid.
 */

import fs from 'fs';
import path from 'path';
import { getSettingsFile } from './paths';

export const VALID_STATUS_ITEMS = [
    'mode', 'model', 'context', 'rpm', 'cost', 'turn', 'duration', 'tps', 'latency',
] as const;

export type StatusBarItem = typeof VALID_STATUS_ITEMS[number];

const DEFAULT_STATUS_ITEMS: StatusBarItem[] = ['mode', 'model', 'context', 'rpm'];

export type WorkflowMode = 'default' | 'solver' | 'tutor-socratic' | 'tutor-guide';

export interface Settings {
    statusBar: {
        items: StatusBarItem[];
    };
    workflowMode: WorkflowMode;
    courseId?: string;
    projectId?: string;
    studentId?: string;
}

export function getSettings(): Settings {
    const defaults: Settings = {
        statusBar: { items: [...DEFAULT_STATUS_ITEMS] },
        workflowMode: 'tutor-socratic',
    };

    try {
        const raw = fs.readFileSync(getSettingsFile(), 'utf-8');
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed?.statusBar?.items)) {
            const valid = parsed.statusBar.items.filter(
                (k: unknown): k is StatusBarItem =>
                    typeof k === 'string' && (VALID_STATUS_ITEMS as readonly string[]).includes(k),
            );
            if (valid.length > 0) {
                defaults.statusBar.items = valid;
            }
        }

        const VALID_MODES: WorkflowMode[] = ['default', 'solver', 'tutor-socratic', 'tutor-guide'];
        if (typeof parsed?.workflowMode === 'string' && VALID_MODES.includes(parsed.workflowMode as WorkflowMode)) {
            defaults.workflowMode = parsed.workflowMode as WorkflowMode;
        }

        if (typeof parsed?.courseId === 'string') defaults.courseId = parsed.courseId;
        if (typeof parsed?.projectId === 'string') defaults.projectId = parsed.projectId;
        if (typeof parsed?.studentId === 'string') defaults.studentId = parsed.studentId;
    } catch {
        // Missing or invalid file — use defaults
    }

    return defaults;
}

export function saveSettings(settings: Settings): void {
    const filePath = getSettingsFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}
