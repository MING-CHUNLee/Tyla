/**
 * StatusBar Component (Ink TUI)
 *
 * Single-line configurable status display matching ContextStatusBar.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { StatusBarVM, StatusBarDisplayConfig, ContextHealthVM } from '../../../shared/view-models/index.js';
import { formatDuration } from '../../../shared/utils/format.js';

interface StatusBarProps {
    vm: StatusBarVM;
    config: StatusBarDisplayConfig;
}

const BAR_WIDTH = 20;

function healthColor(health: ContextHealthVM): string {
    switch (health) {
        case 'healthy': return 'green';
        case 'warning': return 'yellow';
        case 'critical': case 'overflow_risk': return 'red';
    }
}

const StatusBar: React.FC<StatusBarProps> = ({ vm, config }) => {
    const { items = ['model', 'context', 'rpm'] } = config;
    const { health, usagePercent } = vm;
    const color = healthColor(health);

    const filled = Math.round((usagePercent / 100) * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

    const renderers: Record<string, () => React.ReactNode | null> = {
        model: () => <Text>{vm.model}</Text>,
        context: () => (
            <Text>
                <Text color={color}>{bar}</Text>
                <Text color={color}> {usagePercent}%</Text>
            </Text>
        ),
        rpm: () => <Text dimColor>{vm.requestsPerMinute ?? 0} req/min</Text>,
        cost: () => vm.totalCostUSD !== undefined
            ? <Text dimColor>~${vm.totalCostUSD.toFixed(4)}</Text> : null,
        turn: () => vm.turnCount !== undefined
            ? <Text dimColor>turn {vm.turnCount}</Text> : null,
        duration: () => vm.elapsedMs !== undefined
            ? <Text dimColor>{formatDuration(vm.elapsedMs)}</Text> : null,
        tps: () => vm.lastTokensPerSecond !== undefined
            ? <Text dimColor>{vm.lastTokensPerSecond} tok/s</Text> : null,
        latency: () => vm.lastResponseTimeMs !== undefined
            ? <Text dimColor>{formatDuration(vm.lastResponseTimeMs)}</Text> : null,
        tokens: () => (vm.lastInputTokens !== undefined && vm.lastInputTokens > 0)
            ? <Text dimColor>{vm.lastInputTokens.toLocaleString()} in / {(vm.lastOutputTokens ?? 0).toLocaleString()} out</Text>
            : null,
    };

    const parts: React.ReactNode[] = [];
    for (const key of items) {
        const render = renderers[key];
        if (!render) continue;
        const node = render();
        if (!node) continue;
        if (parts.length > 0) parts.push(<Text key={`sep-${key}`} dimColor> · </Text>);
        parts.push(<React.Fragment key={key}>{node}</React.Fragment>);
    }

    return (
        <Box flexDirection="column" paddingX={1}>
            <Box>
                <Text dimColor>── </Text>
                {parts}
                <Text dimColor> ──</Text>
            </Box>
            {health !== 'healthy' && (
                <Text color={color}>
                    {'   '}Context {health === 'warning' ? `at ${usagePercent}%` : `${health} (${usagePercent}%)`}
                </Text>
            )}
        </Box>
    );
};

export default StatusBar;
