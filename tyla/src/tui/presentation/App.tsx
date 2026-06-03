import React from 'react';
import { Box } from 'ink';
import Header from './components/Header.js';
import Footer from './components/Footer.js';
import ChatHistory from './components/ChatHistory.js';
import DiffReview from './components/DiffReview.js';
import InstallReview from './components/InstallReview.js';
import StatusBar from './components/StatusBar.js';
import ThinkingIndicator from './components/ThinkingIndicator.js';
import StreamingMessage from './components/StreamingMessage.js';
import { TUIMessage, AppState, PendingApproval } from './types.js';
import { StatusBarVM, StatusBarDisplayConfig } from '../../shared/view-models/index.js';

export interface AppViewProps {
    messages: TUIMessage[];
    input: string;
    onInputChange: (value: string) => void;
    onSubmit: (value: string) => void;
    appState: AppState;
    pendingApproval: PendingApproval | null;
    onReviewDecision: (approved: boolean) => void;
    isStreaming: boolean;
    streamingContent: string;
    statusData: StatusBarVM | null;
}

const DEFAULT_STATUS_CONFIG: StatusBarDisplayConfig = {
    items: ['model', 'context', 'turn', 'tokens'],
};

const AppView: React.FC<AppViewProps> = ({
    messages,
    input,
    onInputChange,
    onSubmit,
    appState,
    pendingApproval,
    onReviewDecision,
    isStreaming,
    streamingContent,
    statusData,
}) => {
    return (
        <Box flexDirection="column" height="100%">
            <Header messageCount={messages.length} />

            <Box flexGrow={1} flexDirection="column" paddingX={2}>
                <ChatHistory messages={messages} />

                {isStreaming && streamingContent && (
                    <StreamingMessage content={streamingContent} />
                )}

                {appState === 'processing' && !isStreaming && (
                    <ThinkingIndicator />
                )}

                {appState === 'reviewing' && pendingApproval?.kind === 'edit' && (
                    <DiffReview
                        edit={pendingApproval.edit}
                        onDecision={onReviewDecision}
                    />
                )}

                {appState === 'reviewing' && pendingApproval?.kind === 'script' && (
                    <DiffReview
                        edit={{
                            path: '(r script)',
                            diff: pendingApproval.script.code,
                            original: '',
                            proposed: pendingApproval.script.code,
                        }}
                        onDecision={onReviewDecision}
                    />
                )}

                {appState === 'reviewing' && pendingApproval?.kind === 'install' && (
                    <InstallReview
                        plan={pendingApproval.install}
                        onDecision={onReviewDecision}
                    />
                )}
            </Box>

            {statusData && (
                <StatusBar vm={statusData} config={DEFAULT_STATUS_CONFIG} />
            )}

            <Footer
                input={input}
                onInputChange={onInputChange}
                onSubmit={onSubmit}
                appState={appState}
            />
        </Box>
    );
};

export default AppView;
