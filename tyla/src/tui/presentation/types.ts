/**
 * TUI Message Types
 *
 * Extended message types for the interactive REPL TUI.
 */

import {
    ScanResultVM,
    LibraryScanResultVM,
} from '../../shared/view-models/index.js';
import type { DiffLine } from '../../application/services/diff-engine.js';
import { RExecResultVM, RInstallResultVM } from './view-models/index.js';

export type MessageType =
    | 'user'
    | 'assistant'
    | 'thinking'
    | 'tool_call'
    | 'observation'
    | 'diff'
    | 'status'
    | 'error'
    | 'tool_result';

/**
 * Identifies which Ink component should render a tool_result message.
 */
export type ToolResultRenderer = 'scan' | 'library' | 'context' | 'r_exec' | 'r_install';

/**
 * Union of all structured VMs that can appear in a tool_result message.
 */
export type ToolResultVM =
    | ScanResultVM
    | LibraryScanResultVM
    | RExecResultVM
    | RInstallResultVM;

export interface TUIMessage {
    id: string;
    type: MessageType;
    content: string;
    timestamp: Date;
    /** Set when type === 'tool_result'. Selects the Ink component in ChatHistory. */
    renderer?: ToolResultRenderer;
    /** Structured VM payload — only present when type === 'tool_result'. */
    vm?: ToolResultVM;
    metadata?: {
        toolName?: string;
        filePath?: string;
        diffContent?: string;
        original?: string;
        proposed?: string;
        approved?: boolean;
    };
}

export type AppState = 'idle' | 'processing' | 'reviewing';

export interface PendingEdit {
    path: string;
    diff: string;
    diffLines: DiffLine[];
    original: string;
    proposed: string;
}

export interface PendingInstall {
    toInstall: string[];
    alreadyInstalled: string[];
    blocked: Array<{ name: string; reason: string }>;
    warnings: Array<{ name: string; message: string }>;
}

/**
 * One human-in-the-loop approval, discriminated by kind. Replaces the two parallel
 * `pendingReview` / `pendingInstall` slots — `script` (execute_script) is the third
 * variant the tutor dispatch needs, and a future `load_file` approval inherits it for free.
 */
export type PendingApproval =
    | { kind: 'edit';    edit: PendingEdit }
    | { kind: 'install'; install: PendingInstall }
    | { kind: 'script';  script: { code: string } };

export interface TUIConfig {
    directory: string;
    sessionId?: string;
    forceNew?: boolean;
    /** Absolute path to an assignment directory — activates tutor-guide mode with assignment-specific policy. */
    assignmentDir?: string;
    /** Activates tutor-socratic mode without requiring an assignment directory. */
    tutorMode?: boolean;
}
