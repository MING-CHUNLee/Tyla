/**
 * Domain Entity: ConversationTurn
 *
 * Immutable snapshot of one user-instruction → agent-response exchange.
 * Stored append-only inside ConversationSession.
 * Carries FileChange[] (pending file mutations) and LLMOutput[] (text outputs).
 */

import { FileChange, FileChangeJSON } from './file-change';
import { LLMOutput, LLMOutputJSON } from '../values/llm-output';

/** @deprecated Present only in sessions written before the FileChange/LLMOutput split. */
interface ArtifactJSON {
    id: string;
    type: 'edit' | 'diff' | 'code' | 'analysis' | 'report';
    path?: string;
    content: string;
    createdAt: string;
}

/** One guard or tutor API exchange recorded per turn for audit / replay. */
export interface ApiLogEntry {
    timestamp: string;
    source: 'guard' | 'tutor';
    direction: 'request' | 'response';
    payload: unknown;
}

export interface TurnUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    responseTimeMs?: number;
}

export interface TurnJSON {
    turnNumber: number;
    userMessage: string;
    assistantMessage: string;
    usage: TurnUsage;
    timestamp: string;
    fileChanges: FileChangeJSON[];
    outputs: LLMOutputJSON[];
    apiLogs?: ApiLogEntry[];
    /** @deprecated Present only in sessions written before the FileChange/LLMOutput split. */
    artifacts?: ArtifactJSON[];
}

export class ConversationTurn {
    readonly timestamp: Date;

    constructor(
        readonly turnNumber: number,
        readonly userMessage: string,
        readonly assistantMessage: string,
        readonly usage: TurnUsage,
        timestamp?: Date,
        readonly fileChanges: FileChange[] = [],
        readonly outputs: LLMOutput[] = [],
        readonly apiLogs: ApiLogEntry[] = [],
    ) {
        this.timestamp = timestamp ?? new Date();
    }

    /** Expand this turn into the [user, assistant] messages for LLM history */
    toHistoryMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
        return [
            { role: 'user', content: this.userMessage },
            {
                role: 'assistant',
                // A "pure action" turn (e.g. the tutor only returned an edit_file with no
                // prose) leaves assistantMessage empty. Most LLM providers reject an
                // assistant message whose content is the empty string, so an empty turn
                // serialized verbatim poisons the NEXT request's history → HTTP 400
                // (plan 2026-06-16 §1). Substitute a placeholder that both passes schema
                // validation and preserves the "previous turn applied an edit" context.
                // history alternation stays strict user/assistant — nothing downstream
                // that depends on the pairing breaks. The session JSON keeps the real
                // empty string; only the wire history is patched.
                content: this.assistantMessage.trim() === ''
                    ? '(no message — file edit applied)'
                    : this.assistantMessage,
            },
        ];
    }

    toJSON(): TurnJSON {
        return {
            turnNumber: this.turnNumber,
            userMessage: this.userMessage,
            assistantMessage: this.assistantMessage,
            usage: { ...this.usage },
            timestamp: this.timestamp.toISOString(),
            fileChanges: this.fileChanges.map(fc => fc.toJSON()),
            outputs: this.outputs.map(o => o.toJSON()),
            ...(this.apiLogs.length > 0 ? { apiLogs: this.apiLogs } : {}),
        };
    }

    static fromJSON(data: TurnJSON): ConversationTurn {
        let fileChanges: FileChange[];
        let outputs: LLMOutput[];

        const hasLegacy = data.artifacts && data.artifacts.length > 0;
        const hasNew = (data.fileChanges?.length ?? 0) > 0 || (data.outputs?.length ?? 0) > 0;

        if (hasLegacy && !hasNew) {
            // Migration path: old session — split legacy artifacts by type
            fileChanges = data.artifacts!
                .filter(a => a.type === 'edit' || a.type === 'diff')
                .map(a => FileChange.fromJSON({
                    id: a.id,
                    type: a.type as 'edit' | 'diff',
                    path: a.path!,
                    content: a.content,
                    createdAt: a.createdAt,
                }));
            outputs = data.artifacts!
                .filter(a => a.type === 'code' || a.type === 'analysis' || a.type === 'report')
                .map(a => LLMOutput.fromJSON({
                    id: a.id,
                    type: a.type as 'code' | 'analysis' | 'report',
                    content: a.content,
                    createdAt: a.createdAt,
                }));
        } else {
            fileChanges = (data.fileChanges ?? []).map(fc => FileChange.fromJSON(fc));
            outputs = (data.outputs ?? []).map(o => LLMOutput.fromJSON(o));
        }

        return new ConversationTurn(
            data.turnNumber,
            data.userMessage,
            data.assistantMessage,
            data.usage,
            new Date(data.timestamp),
            fileChanges,
            outputs,
            data.apiLogs ?? [],
        );
    }
}
