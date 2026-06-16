/**
 * Service: session-turn builder (plan Option C §7 — frontend switchover).
 *
 * Converges each completed ConversationTurn into the rich `SessionTurn` the backend
 * tutor pipeline consumes, REPLACING the pre-compressed `history` the frontend used
 * to serialize itself. Under Option C the backend owns compression, so this builder
 * only EXTRACTS materials — no caps, no placeholder wording, no neutral edit phrasing,
 * no `seen_paths` parsing (all of that moved to the backend `HistoryTurnSerializer`).
 *
 * Materials per turn (all already on the turn — no schema change):
 *   - prompt          ← turn.userMessage (verbatim; backend strips pasted code)
 *   - prose           ← turn.assistantMessage (terminal content; '' for action-only)
 *   - context_headers ← headers-only block of the TERMINAL tutor request's file_context
 *   - actions         ← the TERMINAL tutor response's actions
 *
 * A student turn carries multiple tutor request/response pairs only on B3 continuation
 * (plan 2026-06-15 §3.1); `file_context` accumulates monotonically across them, so the
 * LAST request already holds the union of every file seen this turn (§3.2) and the LAST
 * response is the terminal reply. We therefore converge on the last of each — no union
 * pass needed. Turns without tutor apiLogs (ask/run/agent/legacy) degrade to a plain
 * prompt+prose entry.
 */

import { ConversationSession } from '../../domain/entities/conversation-session';
import { ConversationTurn, ApiLogEntry } from '../../domain/entities/conversation-turn';
import { SessionTurn } from '../../shared/types/session-turn';
import { TutorAction, isTutorAction } from '../../shared/types/tutor-actions';
import { toHeadersOnlyBlock } from './line-numbering';

/** Build the `session_turns` payload for every prior turn in the session. */
export function buildSessionTurns(session: ConversationSession): SessionTurn[] {
    return session.turns.map(buildSessionTurn);
}

/** Converge a single turn into its rich `SessionTurn` entry. */
export function buildSessionTurn(turn: ConversationTurn): SessionTurn {
    const result: SessionTurn = { prompt: turn.userMessage };
    if (turn.assistantMessage) result.prose = turn.assistantMessage;

    const tutorLogs = turn.apiLogs.filter(l => l.source === 'tutor');
    const lastRequest  = findLast(tutorLogs, l => l.direction === 'request');
    const lastResponse = findLast(tutorLogs, l => l.direction === 'response');

    const headers = toHeadersOnlyBlock(fileContextOf(lastRequest));
    if (headers) result.context_headers = headers;

    const actions = actionsOf(lastResponse);
    if (actions.length > 0) result.actions = actions;

    return result;
}

// ── Private helpers ─────────────────────────────────────────────────────────

/** Last element satisfying `pred` (Array.prototype.findLast is ES2023; target is ES2020). */
function findLast<T>(items: ReadonlyArray<T>, pred: (item: T) => boolean): T | undefined {
    for (let i = items.length - 1; i >= 0; i--) {
        if (pred(items[i])) return items[i];
    }
    return undefined;
}

/** Best-effort read of a request payload's `file_context` string. */
function fileContextOf(log?: ApiLogEntry): string {
    const fc = (log?.payload as { file_context?: unknown } | undefined)?.file_context;
    return typeof fc === 'string' ? fc : '';
}

/**
 * Well-formed actions from a response payload. Filtered through `isTutorAction`
 * (the same leniency the gateway applies) so a malformed action a server version
 * emitted never reaches the backend serializer. `load_file` is kept: under Option C
 * the backend render table handles every action type, including a terminal load_file.
 */
function actionsOf(log?: ApiLogEntry): TutorAction[] {
    const raw = (log?.payload as { actions?: unknown } | undefined)?.actions;
    return Array.isArray(raw) ? raw.filter(isTutorAction) : [];
}
