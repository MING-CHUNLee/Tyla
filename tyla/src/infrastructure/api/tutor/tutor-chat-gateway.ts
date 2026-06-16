import axios from 'axios';
import { TutorAction, isTutorAction } from '../../../shared/types/tutor-actions';
import { SessionMessage } from '../../../shared/types/messages';
import { SessionTurn } from '../../../shared/types/session-turn';
import { TYLA_API } from '../../config/constants';
import { buildTylaApiRequest } from '../shared/build-llm-headers';
import { parseUsage, Usage } from '../shared/parse-usage';
import { debugLog } from '../shared/debug-log';

// ── Wire types ────────────────────────────────────────────────────────────────

interface TutorChatResponse {
    log_id: number;
    status: 'done' | 'forbidden' | 'error' | 'unavailable';   // unified ApiStatus
    content: string;
    actions?: unknown[];          // validated → TutorAction[] in send()
    usage: { input_tokens: number; output_tokens: number } | null;
    /** Backend trim notices, e.g. "file_context_dropped" (plan 2026-06-11 §2.7). Older backends omit it. */
    warnings?: unknown[];
}

// ── Domain result ─────────────────────────────────────────────────────────────

/** Raw HTTP request/response bodies captured for session audit log. */
export interface TutorRawExchange {
    requestBody: unknown;
    requestAt: string;
    responseBody: unknown;
    responseAt: string;
}

export type TutorChatResult =
    | { status: 'done' | 'unavailable'; logId: number; content: string; actions: TutorAction[]; usage: Usage; guardSkipped: boolean; warnings: string[]; rawExchange?: TutorRawExchange }
    | { status: 'forbidden';            logId: number; content: string; usage: Usage; rawExchange?: TutorRawExchange }
    | { status: 'error';                logId: number; content: string; usage: Usage; rawExchange?: TutorRawExchange };

// ── Gateway ───────────────────────────────────────────────────────────────────

export class TutorChatGateway {
    private readonly baseUrl: string;
    private readonly timeout: number;

    constructor(
        private readonly onWarning?: (message: string) => void,
        private readonly directory?: string,
    ) {
        this.baseUrl = `http://${TYLA_API.HOST}:${TYLA_API.PORT}`;
        this.timeout = TYLA_API.TUTOR_TIMEOUT_MS;
    }

    async send(
        prompt: string,
        history: SessionMessage[],
        guardLogId: number,
        fileContext?: string,
        workspaceOverview?: string,
        sessionTurns?: SessionTurn[],
    ): Promise<TutorChatResult> {
        const { profile, headers } = buildTylaApiRequest('tutor-api', this.directory);

        // Two explicit channels (plan 2026-06-12): `workspace_overview` is the cheap
        // file-listing manifest (no contents/line numbers); `file_context` is the
        // line-numbered contents of files actually loaded (@-mention or load_file).
        // The backend gate uses `workspace_overview`'s presence as the contract-version
        // marker, so we send it whenever a scan produced a summary.
        const body = {
            course_id:  profile.courseId,
            project_id: profile.projectId,
            student_id: profile.studentId,
            guard_log_id: guardLogId,
            prompt,
            history,
            // Option C (plan 2026-06-15 §2.2/§2.4): rich, uncompressed turns. When present
            // the backend ignores `history` and runs its own HistoryTurnSerializer + rolling
            // summary; we still send `history` for backward compat during the switchover (§7).
            ...(sessionTurns && sessionTurns.length > 0 ? { session_turns: sessionTurns } : {}),
            ...(fileContext ? { file_context: fileContext } : {}),
            ...(workspaceOverview ? { workspace_overview: workspaceOverview } : {}),
        };
        const requestAt = new Date().toISOString();
        debugLog('tutor', 'REQUEST', body);

        const response = await axios.post<TutorChatResponse>(
            `${this.baseUrl}/api/v1/tutor_chats`,
            body,
            {
                timeout: this.timeout,
                headers,
                validateStatus: (status) => status === 200 || status === 202,
            },
        );

        const data = response.data;
        const responseAt = new Date().toISOString();
        debugLog('tutor', 'RESPONSE', data);
        const rawExchange: TutorRawExchange = { requestBody: body, requestAt, responseBody: data, responseAt };

        if (data.status === 'forbidden') {
            return {
                status:  'forbidden',
                logId:   data.log_id,
                content: data.content,
                usage:   parseUsage(data.usage),
                rawExchange,
            };
        }

        if (data.status === 'error') {
            return {
                status:  'error',
                logId:   data.log_id,
                content: data.content,
                usage:   parseUsage(data.usage),
                rawExchange,
            };
        }

        const guardSkipped = data.status === 'unavailable';
        if (guardSkipped) {
            this.onWarning?.('guard skipped: llm unavailable');
        }

        // Q-B2: keep only well-formed actions; drop the rest, never throw.
        const actions: TutorAction[] = Array.isArray(data.actions)
            ? data.actions.filter(isTutorAction)
            : [];

        // §2.7: surface backend trim notices; missing field (older backend) → [].
        const warnings: string[] = Array.isArray(data.warnings)
            ? data.warnings.filter((w): w is string => typeof w === 'string')
            : [];

        return {
            status:      data.status,
            logId:       data.log_id,
            content:     data.content,
            actions,
            guardSkipped,
            warnings,
            usage: parseUsage(data.usage),
            rawExchange,
        };
    }
}
