/**
 * DiffReview Component
 *
 * Renders a proposed file diff and captures Y/N key press for approval.
 * Replaces readline-based promptConfirm in the TUI context.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { PendingEdit } from '../types.js';

interface DiffReviewProps {
    edit: PendingEdit;
    onDecision: (approved: boolean) => void;
}

const LINE_COLOR: Record<string, string> = {
    added:   'green',
    removed: 'red',
    context: 'gray',
};

const DiffReview: React.FC<DiffReviewProps> = ({ edit, onDecision }) => {
    useInput((input: string, key: { return?: boolean; escape?: boolean }) => {
        const lower = input.toLowerCase();
        if (lower === 'y' || key.return) {
            onDecision(true);
        } else if (lower === 'n' || key.escape) {
            onDecision(false);
        }
    });

    return (
        <Box flexDirection="column" marginY={1}>
            <Box borderStyle="round" borderColor="yellow" paddingX={2} flexDirection="column">
                <Text bold color="yellow">
                    Review: {edit.path}
                </Text>
                <Box marginTop={1} flexDirection="column">
                    {(edit.diffLines ?? []).map((line, i) => (
                        <Text key={i} color={LINE_COLOR[line.kind]}>{line.text}</Text>
                    ))}
                </Box>
                <Box marginTop={1}>
                    <Text color="yellow" bold>
                        Apply changes? [Y] Accept  [N] Reject
                    </Text>
                </Box>
            </Box>
        </Box>
    );
};

export default DiffReview;
