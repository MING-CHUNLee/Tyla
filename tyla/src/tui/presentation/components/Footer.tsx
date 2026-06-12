import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { AppState } from '../types.js';

interface FooterProps {
    input: string;
    onInputChange: (value: string) => void;
    onSubmit: (value: string) => void;
    appState: AppState;
}

const Footer: React.FC<FooterProps> = ({
    input,
    onInputChange,
    onSubmit,
    appState,
}) => {
    return (
        <Box flexDirection="column">
            <Box
                borderStyle="round"
                borderColor={appState === 'reviewing' ? 'yellow' : 'magenta'}
                paddingX={2}
                paddingY={0}
            >
                <Box width="100%">
                    {appState === 'idle' ? (
                        <>
                            <Text color="magenta" bold>
                                {'> '}
                            </Text>
                            <TextInput
                                value={input}
                                onChange={onInputChange}
                                onSubmit={onSubmit}
                                placeholder="Type your instruction... (/help for commands)"
                            />
                        </>
                    ) : appState === 'reviewing' ? (
                        <Text color="yellow" bold>
                            Review mode
                        </Text>
                    ) : (
                        <>
                            <Text color="magenta" bold>
                                {'> '}
                            </Text>
                            <Text color="yellow">Processing...</Text>
                        </>
                    )}
                </Box>
            </Box>
            <Box paddingX={2}>
                <Text color="gray" dimColor>
                    {appState === 'idle' ? (
                        <>
                            Press <Text color="yellow">ESC</Text> or{' '}
                            <Text color="yellow">Ctrl+C</Text> to exit ·{' '}
                            <Text color="yellow">/help</Text> for commands
                        </>
                    ) : appState === 'reviewing' ? (
                        <>Respond in the review box above</>
                    ) : (
                        <>Agent is working...</>
                    )}
                </Text>
            </Box>
        </Box>
    );
};

export default Footer;
