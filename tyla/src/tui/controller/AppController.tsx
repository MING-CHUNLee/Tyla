import React, { useState, useEffect, useCallback, useRef } from 'react';
import path from 'path';
import { useInput, useApp } from 'ink';

import AppView from '../presentation/App.js';
import { TUIMessage, AppState, PendingApproval, TUIConfig } from '../presentation/types.js';
import { mapAgentEventToMessage, AgentEvent, ProposedEdit, nextId } from '../presentation/event-mapper.js';
import { StatusBarVM } from '../../shared/view-models/index.js';
import type { ProposedInstall } from '../../application/services/agent-service.js';

interface AppControllerProps {
    config?: TUIConfig;
}

function makeStatusMessage(content: string): TUIMessage {
    return { id: nextId(), type: 'status', content, timestamp: new Date() };
}

// Same `@<file>` convention as the use case's FILE_MENTION_RE (plan 2026-06-11
// §2.6) — presentation-layer input hint only, no event, never enters the pipeline.
const FILE_MENTION_RE = /@([\w\-./\\]+)/;

const AppController: React.FC<AppControllerProps> = ({ config }) => {
    const { exit } = useApp();

    const assignmentName = config?.assignmentDir
        ? path.basename(config.assignmentDir)
        : undefined;

    const [messages, setMessages] = useState<TUIMessage[]>([
        makeStatusMessage(
            assignmentName
                ? `Welcome to Tyla CLI! Assignment: ${assignmentName} — tutor-guide mode active. /help for commands.`
                : 'Welcome to Tyla CLI! Type your instruction and press Enter. /help for commands.',
        ),
    ]);
    const [input, setInput] = useState('');
    const [appState, setAppState] = useState<AppState>('idle');
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [streamingContent, setStreamingContent] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [statusData, setStatusData] = useState<StatusBarVM | null>(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentServiceRef = useRef<any>(null);
    const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);
    const atHintShownRef = useRef(false);   // §2.6: show the @-hint once per session

    const addMessage = useCallback((msg: TUIMessage) => {
        setMessages(prev => [...prev, msg]);
    }, []);

    const addStatusMessage = useCallback((content: string) => {
        addMessage(makeStatusMessage(content));
    }, [addMessage]);

    // ── Agent event handler (pure mapping delegated to event-mapper) ──────

    const handleAgentEvent = useCallback((event: AgentEvent) => {
        const { message, sideEffect } = mapAgentEventToMessage(event);

        if (message) addMessage(message);

        if (sideEffect) {
            if (sideEffect.finalizeStream) {
                setIsStreaming(false);
                setStreamingContent('');
            }
            if (sideEffect.streamingToken !== undefined) {
                setIsStreaming(true);
                setStreamingContent(prev => prev + sideEffect.streamingToken);
            }
            if (sideEffect.pendingApproval) {
                setPendingApproval(sideEffect.pendingApproval);
                setAppState('reviewing');
            }
            if (sideEffect.nextAppState && sideEffect.nextAppState !== 'reviewing') {
                setAppState(sideEffect.nextAppState);
            }
            if (sideEffect.statusData) {
                setStatusData(sideEffect.statusData);
            }
        }
    }, [addMessage]);

    // ── Approval callbacks — suspend agent until user decides ─────────────

    const onApproval = useCallback(async (_edit: ProposedEdit): Promise<boolean> => {
        return new Promise<boolean>(resolve => {
            approvalResolverRef.current = resolve;
        });
    }, []);

    const onInstallApproval = useCallback(async (_plan: ProposedInstall): Promise<boolean> => {
        return new Promise<boolean>(resolve => {
            approvalResolverRef.current = resolve;
        });
    }, []);

    const handleReviewDecision = useCallback((approved: boolean) => {
        approvalResolverRef.current?.(approved);
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setAppState('processing');
    }, []);

    // ── Agent initialization (dynamic import avoids ESM/CJS mismatch) ─────

    useEffect(() => {
        const initAgent = async () => {
            const mod = await import('../../composition/create-agent-controller.js');
            const dir = config?.directory ?? process.cwd();
            const service = mod.createAgentController({
                directory: dir,
                viewAdapter: handleAgentEvent,
                approvalGate: onApproval,
                installApprovalGate: onInstallApproval,
                assignmentDir: config?.assignmentDir,
                tutorMode: config?.tutorMode,
            });
            await service.initialize({
                sessionId: config?.sessionId,
                forceNew:  config?.forceNew,
            });
            agentServiceRef.current = service;
        };

        initAgent().catch(err => {
            const isApiKeyError =
                err.message?.includes('No API key found') || err.message?.includes('API key');
            const content = isApiKeyError
                ? err.message
                : `Failed to initialize agent: ${err.message ?? err}`;
            addMessage({ id: nextId(), type: 'error', content, timestamp: new Date() });
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Keyboard shortcuts ────────────────────────────────────────────────

    useInput((keyInput: string, key: { escape?: boolean; ctrl?: boolean }) => {
        if (appState === 'idle' && (key.escape || (key.ctrl && keyInput === 'c'))) {
            exit();
        }
    });

    // ── Submit handler (input decision logic lives here, not in view) ─────

    const handleSubmit = useCallback(async (userInput: string) => {
        if (!userInput.trim() || appState !== 'idle') return;

        const service = agentServiceRef.current;
        if (!service) {
            addStatusMessage('Agent is not ready. Please check your .env file has a valid API key and restart tyla.');
            return;
        }

        addMessage({ id: nextId(), type: 'user', content: userInput, timestamp: new Date() });
        setInput('');

        // Slash commands
        if (userInput.startsWith('/')) {
            if (userInput.trim() === '/exit') { exit(); return; }
            const result = await service.handleSlashCommand(userInput.trim());
            addMessage({ id: nextId(), type: 'assistant', content: result, timestamp: new Date() });
            return;
        }

        // §2.6: tutor file reads are @-gated — nudge (once) when no @ token is present.
        if (config?.tutorMode && !FILE_MENTION_RE.test(userInput) && !atHintShownRef.current) {
            atHintShownRef.current = true;
            addStatusMessage('Tip: type @filename (e.g. @hw2.R) to share a file with the tutor.');
        }

        // Run agent
        setAppState('processing');
        setStreamingContent('');
        setIsStreaming(false);

        try {
            await service.executeInstruction(userInput);
        } catch (err) {
            addMessage({
                id: nextId(),
                type: 'error',
                content: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: new Date(),
            });
        }

        setIsStreaming(false);
        setStreamingContent('');
        setAppState('idle');
    }, [appState, addMessage, addStatusMessage, exit, config?.tutorMode]);

    return (
        <AppView
            messages={messages}
            input={input}
            onInputChange={setInput}
            onSubmit={handleSubmit}
            appState={appState}
            pendingApproval={pendingApproval}
            onReviewDecision={handleReviewDecision}
            isStreaming={isStreaming}
            streamingContent={streamingContent}
            statusData={statusData}
        />
    );
};

export default AppController;
