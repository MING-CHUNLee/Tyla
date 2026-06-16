/**
 * Rich session turn forwarded to the backend tutor pipeline
 * (plan Tyla-api/2026-06-15-option-c-backend-owned-history-compression §2.2).
 *
 * Under Option C the backend OWNS history compression: its `HistoryTurnSerializer`
 * collapses each `SessionTurn` into a `[{ role, content }]` pair (placeholder wording,
 * caps, neutral edit phrasing, pair-or-skip) and its assembler runs the rolling
 * summary (§5.3). The frontend therefore only FORWARDS materials — it does NOT
 * serialize, truncate, or parse `seen_paths`.
 *
 * Field names are snake_case to match the backend contract verbatim.
 */
import { TutorAction } from './tutor-actions';

export interface SessionTurn {
    /** The student's intent, verbatim. The backend strips pasted code blocks. */
    prompt: string;
    /** Terminal assistant prose. Absent for an action-only turn (backend fills a fallback). */
    prose?: string;
    /**
     * Headers-only block of this turn's `file_context`: the `### <path>` heading
     * lines only, with every `N| ` content line stripped (§3.2). The backend parses
     * `seen_paths` from it via the shared `FileContextHeader` constant — the frontend
     * only WRITES the headers (it is the file_context producer), it never parses them.
     */
    context_headers?: string;
    /** Terminal tutor-response actions. The backend renders each type neutrally (§4.1). */
    actions?: TutorAction[];
}
