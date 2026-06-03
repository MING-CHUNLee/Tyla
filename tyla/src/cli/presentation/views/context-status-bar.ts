/**
 * Views: Context Status Bar
 *
 * Single-line configurable status display after each agent turn.
 * Default: mode · model · context bar % · turn · cost
 *
 * Design rules (Presentation Layer SKILL.md):
 *   - `formatStatusBar()` is PURE — returns string[] only, no console.log.
 *   - `displayStatusBar()` is a thin I/O wrapper.
 *   - No imports from domain/, application/, or infrastructure/.
 *   - Accepts StatusBarVM + StatusBarDisplayConfig (Presentation View Models only).
 *   - Caller (controller) is responsible for reading settings and passing them in.
 */

import chalk from 'chalk';
import { StatusBarVM, StatusBarDisplayConfig, StatusBarItemKey, ContextHealthVM } from '../../../shared/view-models';
import { formatDuration } from '../../../shared/utils/format';

const BAR_WIDTH = 20;

// ─── Item Renderers — pure functions ──────────────────────────────────────

type ItemRenderer = (vm: StatusBarVM, config: StatusBarDisplayConfig) => string | undefined;

const RENDERERS: Record<StatusBarItemKey, ItemRenderer> = {
    mode: (_vm, config) =>
        config.workflowMode && config.workflowMode !== 'default'
            ? chalk.bold.cyan(`[${config.workflowMode}]`)
            : undefined,

    model: (vm) => chalk.white(vm.model),

    context: (vm) => {
        const bar = makeBar(vm.usagePercent, vm.health);
        const pct = colorByHealth(`${vm.usagePercent}%`, vm.health);
        return `${bar} ${pct}`;
    },

    rpm: (vm) =>
        vm.requestsPerMinute !== undefined
            ? chalk.dim(`${vm.requestsPerMinute} req/min`)
            : undefined,

    cost: (vm) => chalk.dim(`~$${vm.totalCostUSD.toFixed(4)}`),

    turn: (vm) => chalk.dim(`turn ${vm.turnCount}`),

    duration: (vm) =>
        vm.elapsedMs !== undefined
            ? chalk.dim(formatDuration(vm.elapsedMs))
            : undefined,

    tps: (vm) =>
        vm.lastTokensPerSecond !== undefined
            ? chalk.dim(`${vm.lastTokensPerSecond} tok/s`)
            : undefined,

    latency: (vm) =>
        vm.lastResponseTimeMs !== undefined
            ? chalk.dim(formatDuration(vm.lastResponseTimeMs))
            : undefined,

    tokens: (vm) =>
        vm.lastInputTokens !== undefined && vm.lastInputTokens > 0
            ? chalk.dim(`${vm.lastInputTokens.toLocaleString()} in / ${(vm.lastOutputTokens ?? 0).toLocaleString()} out`)
            : undefined,
};

// ─── Pure Formatters ───────────────────────────────────────────────────────

/**
 * Format the status bar line + optional health warning. Pure — returns string[].
 */
export function formatStatusBar(vm: StatusBarVM, config: StatusBarDisplayConfig): string[] {
    const parts: string[] = [];

    for (const key of config.items) {
        const renderer = RENDERERS[key];
        if (!renderer) continue;
        const text = renderer(vm, config);
        if (text) parts.push(text);
    }

    const line   = parts.join(chalk.dim(' · '));
    const border = chalk.dim('──');

    const lines: string[] = [
        '',
        `${border} ${line} ${border}`,
    ];

    const warning = formatHealthWarning(vm.health, vm.usagePercent);
    if (warning) lines.push(warning);

    lines.push('');
    return lines;
}

/**
 * Format a health warning message. Returns undefined when no warning needed.
 */
export function formatHealthWarning(health: ContextHealthVM, percent: number): string | undefined {
    switch (health) {
        case 'warning':
            return chalk.yellow(`   Context at ${percent}% — consider --new for a fresh session soon`);
        case 'critical':
            return chalk.red(`   Context critical (${percent}%) — agent may lose early context`);
        case 'overflow_risk':
            return chalk.bold.red(`   Context overflow risk (${percent}%) — run with --new to start fresh`);
        default:
            return undefined;
    }
}

// ─── Display (thin I/O wrapper) ────────────────────────────────────────────

/**
 * Display the status bar to stdout.
 * Caller must build StatusBarVM and StatusBarDisplayConfig from settings/session.
 */
export function displayStatusBar(vm: StatusBarVM, config: StatusBarDisplayConfig): void {
    for (const line of formatStatusBar(vm, config)) {
        console.log(line);
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeBar(percent: number, health: ContextHealthVM): string {
    const filled = Math.round((percent / 100) * BAR_WIDTH);
    const empty  = BAR_WIDTH - filled;
    const raw    = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
    return colorByHealth(raw, health);
}

function colorByHealth(text: string, health: ContextHealthVM): string {
    switch (health) {
        case 'healthy':       return chalk.green(text);
        case 'warning':       return chalk.yellow(text);
        case 'critical':      return chalk.red(text);
        case 'overflow_risk': return chalk.bold.red(text);
    }
}
