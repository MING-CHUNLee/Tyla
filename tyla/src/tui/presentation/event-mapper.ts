/**
 * TUI Event Mapper
 *
 * Pure adapter: maps AgentService domain events → TUIMessage display objects.
 *
 * Design rules (Presentation Layer SKILL.md):
 *   - PURE function — no React state, no console.log, no side effects.
 *   - Receives a raw AgentEvent, returns a TUIMessage (View Model) or null.
 *   - All truncation, formatting, and message-type selection lives here.
 *   - App.tsx calls this function and feeds results into React state.
 *
 * Separating this from App.tsx satisfies the Single Responsibility Principle
 * (Martin Fowler — Separated Presentation) and makes the mapping testable
 * without rendering any React components.
 */

import { TUIMessage, AppState, PendingInstall } from './types';
import {
    StatusBarVM, ContextHealthVM,
    ScanResultVM, LibraryScanResultVM,
} from '../../shared/view-models/index.js';
import { RExecResultVM, RInstallResultVM } from './view-models/index.js';

// Import the canonical types from the application layer for local use,
// and re-export them so App.tsx can continue importing from this module.
import type { AgentEvent, ProposedEdit } from '../../application/services/agent-service.js';
export type { AgentEvent, ProposedEdit };

/**
 * Side-effecting state mutations needed by some events (diff review, streaming).
 * Returned alongside the message so App.tsx can apply them.
 */
export interface EventSideEffect {
    pendingReview?: ProposedEdit;
    pendingInstall?: PendingInstall;
    nextAppState?: AppState;
    streamingToken?: string;
    finalizeStream?: boolean;
    statusData?: StatusBarVM;
}

export interface MappedEvent {
    message?: TUIMessage;
    sideEffect?: EventSideEffect;
}

// ─── ID generation ────────────────────────────────────────────────────────

let msgCounter = 0;
export function nextId(): string {
    return `msg-${Date.now()}-${++msgCounter}`;
}

function makeMessage(
    type: TUIMessage['type'],
    content: string,
    metadata?: TUIMessage['metadata'],
): TUIMessage {
    return { id: nextId(), type, content, timestamp: new Date(), metadata };
}

// ─── Pure Mapper ──────────────────────────────────────────────────────────

/**
 * Map a single AgentEvent to a TUIMessage + optional side effects.
 * Returns `{}` (empty object) when the event has no visible output.
 */
export function mapAgentEventToMessage(event: AgentEvent): MappedEvent {
    switch (event.type) {

        case 'session_loaded': {
            const { sessionId, turnCount, model } = event.data as {
                sessionId: string; turnCount: number; model: string;
            };
            const content = turnCount > 0
                ? `Resumed session ${(sessionId).slice(-6)} (${turnCount} previous turns) · ${model}`
                : `New session ${(sessionId).slice(-6)} · ${model}`;
            return { message: makeMessage('status', content) };
        }

        case 'intent_classified':
            return { message: makeMessage('status', `Intent: ${event.data.intent}`) };

        case 'phase_start':
            return { message: makeMessage('status', `${event.data.description}...`) };

        case 'phase_end':
            if (event.data.summary) {
                return { message: makeMessage('status', event.data.summary as string) };
            }
            return {};

        case 'react_step': {
            const { thought, action, observation } = event.data;
            // Return the most important message (thought → action → observation priority)
            if (thought) return { message: makeMessage('thinking', (thought as string).slice(0, 200)) };
            if (action)  return { message: makeMessage('tool_call', `${(action as { tool: string }).tool}`) };
            if (observation) return { message: makeMessage('observation', (observation as string).slice(0, 150)) };
            return {};
        }

        case 'text_output':
            return {
                message:    makeMessage('assistant', event.data.content as string),
                sideEffect: { finalizeStream: true },
            };

        case 'stream_token':
            return { sideEffect: { streamingToken: event.data.token as string } };

        case 'diff_proposed': {
            const edit = event.data as unknown as ProposedEdit;
            return {
                sideEffect: {
                    pendingReview: {
                        path:     edit.path,
                        diff:     edit.diff,
                        original: edit.original,
                        proposed: edit.proposed,
                    },
                    nextAppState: 'reviewing',
                },
            };
        }

        case 'edit_applied':
            return { message: makeMessage('status', `Applied: ${event.data.path}`) };

        case 'edit_rejected':
            return { message: makeMessage('status', `Rejected: ${event.data.path}`) };

        case 'turn_saved': {
            const d = event.data;
            return {
                sideEffect: {
                    statusData: {
                        turnCount:          d.turnCount,
                        model:              d.model,
                        usagePercent:       d.usagePercent,
                        health:             d.health as ContextHealthVM,
                        totalCostUSD:       d.totalCostUSD,
                        lastInputTokens:    d.lastInputTokens,
                        lastOutputTokens:   d.lastOutputTokens,
                        lastResponseTimeMs: d.lastResponseTimeMs,
                    } satisfies StatusBarVM,
                },
            };
        }

        case 'status_update': {
            const parts: string[] = [];
            if (event.data.warning)   parts.push(`⚠ ${event.data.warning}`);
            if (event.data.plugins)   parts.push(`Plugins: ${event.data.plugins.join(', ')}`);
            if (event.data.knowledge) parts.push(`Knowledge: ${event.data.knowledge.join(', ')}`);
            if (parts.length === 0)   return {};
            return { message: makeMessage('status', parts.join(' | ')) };
        }

        case 'tool_result_scan': {
            const raw = event.data.data as {
                baseDirectory: string;
                totalFiles: number;
                files: {
                    rScripts:  Array<{ name: string; path: string; size?: number }>;
                    rMarkdown: Array<{ name: string; path: string; size?: number }>;
                    rData:     Array<{ name: string; path: string; size?: number }>;
                    rProject:  Array<{ name: string; path: string; size?: number }>;
                    dataFiles: Array<{ name: string; path: string; size?: number }>;
                    documents: Array<{ name: string; path: string; size?: number }>;
                };
                projectInfo?: { name: string; type: string };
            };
            const toVM = (arr: Array<{ path: string; size?: number }>) =>
                arr.map(f => ({ path: f.path, size: f.size ?? 0 }));
            const vm: ScanResultVM = {
                rScripts:  toVM(raw.files.rScripts  ?? []),
                rMarkdown: toVM(raw.files.rMarkdown ?? []),
                rData:     toVM(raw.files.rData     ?? []),
                rProject:  toVM(raw.files.rProject  ?? []),
                dataFiles: toVM(raw.files.dataFiles ?? []),
                documents: toVM(raw.files.documents ?? []),
                totalFiles:    raw.totalFiles,
                projectName:   raw.projectInfo?.name,
                baseDir:       raw.baseDirectory,
                maxFilesDisplay: 5,
            };
            return { message: { ...makeMessage('tool_result', ''), renderer: 'scan', vm } };
        }

        case 'tool_result_library': {
            const raw = event.data.data as {
                rVersion: string; rHome: string; libraryPaths: string[];
                totalLibraries: number; basePackages: number; userPackages: number;
                libraries: Array<{ name: string; version: string; isBase: boolean }>;
            };
            const vm: LibraryScanResultVM = {
                rVersion:       raw.rVersion,
                rHome:          raw.rHome,
                libraryPaths:   raw.libraryPaths,
                totalLibraries: raw.totalLibraries,
                basePackages:   raw.basePackages,
                userPackages:   raw.userPackages,
                libraries:      raw.libraries.map(l => ({ name: l.name, version: l.version, isBase: l.isBase })),
            };
            return { message: { ...makeMessage('tool_result', ''), renderer: 'library', vm } };
        }

        case 'tool_result_r_exec': {
            const vm = event.data.data as RExecResultVM;
            return { message: { ...makeMessage('tool_result', ''), renderer: 'r_exec', vm } };
        }

        case 'tool_result_r_install': {
            const vm = event.data.data as RInstallResultVM;
            return { message: { ...makeMessage('tool_result', ''), renderer: 'r_install', vm } };
        }

        case 'install_proposed': {
            const d = event.data as unknown as PendingInstall;
            return {
                sideEffect: {
                    pendingInstall: {
                        toInstall:        d.toInstall,
                        alreadyInstalled: d.alreadyInstalled,
                        blocked:          d.blocked,
                        warnings:         d.warnings,
                    },
                    nextAppState: 'reviewing',
                },
            };
        }

        case 'error':
            return { message: makeMessage('error', `[${event.data.phase}] ${event.data.message}`) };

        default:
            return {};
    }
}
