import fs from 'fs';
import path from 'path';

function getDebugLogPath(): string {
    return path.join(process.cwd(), '.tyla', 'debug.log');
}

export function debugLog(tag: string, direction: 'REQUEST' | 'RESPONSE', payload: unknown): void {
    if (!['1', 'true'].includes((process.env['DEBUG'] ?? '').toLowerCase())) return;
    const line = `[${new Date().toISOString()}] [${tag}] ${direction}\n${JSON.stringify(payload, null, 2)}\n\n`;
    try {
        fs.appendFileSync(getDebugLogPath(), line, 'utf-8');
    } catch {
        // log dir may not exist yet — fail silently so debug logging never breaks the app
    }
}
