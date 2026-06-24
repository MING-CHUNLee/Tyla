import axios, { AxiosResponse, isAxiosError } from 'axios';
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
    | { status: 'error';                logId: number; content: string; usage: Usage; rawExchange?: TutorRawExchange }
    // 429 from the provider (plan 2026-06-18 §6, C). No logId (the 429 body need not
    // carry one) and no rawExchange (this is the error path — the catch block already
    // wrote the RESPONSE debug log). The use case turns this into a back-off prompt.
    | { status: 'rate_limited';         retryAfterSeconds: number | null; limitDimension: 'requests' | 'tokens' | 'unknown' }
    // 413 from the backend (provider per-request token cap; plan 2026-06-24 D).
    // Never retry — same body will always re-trigger 413.
    // maxInputTokens is null when the backend omitted it (pre-flight context_overflow path).
    | { status: 'input_too_large'; maxInputTokens: number | null };

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

        let response: AxiosResponse<TutorChatResponse>;
        try {
            response = await axios.post<TutorChatResponse>(
                `${this.baseUrl}/api/v1/tutor_chats`,
                body,
                {
                    timeout: this.timeout,
                    headers,
                    validateStatus: (status) => status === 200 || status === 202,
                },
            );
        } catch (error) {
            // A non-whitelisted status (e.g. the backend's 400 request-validation reject)
            // makes axios throw HERE — before the RESPONSE log below ever runs, which is
            // why debug.log shows a REQUEST with no matching RESPONSE (plan 2026-06-16 §1.4).
            // Capture the backend's real error body so the failure is diagnosable, then
            // rethrow with that detail folded into the message — the bare AxiosError string
            // ("Request failed with status code 400") hides which field the backend rejected.
            if (isAxiosError(error) && error.response) {
                debugLog('tutor', 'RESPONSE', {
                    httpStatus: error.response.status,
                    body: error.response.data,
                });

                // 429: return a structured result so the use case can render the
                // correct back-off guidance (plan 2026-06-18 §6, C — "wait & retry",
                // never "open a new conversation"). Distinct from the generic throw below.
                if (error.response.status === 429) {
                    const body = error.response.data as {
                        errors?: { retry_after?: string | number; limit_dimension?: string };
                    };
                    const ra = body?.errors?.retry_after;
                    const retryAfterSeconds = ra != null ? Number(ra) : null;
                    const dim = body?.errors?.limit_dimension;
                    const limitDimension: 'requests' | 'tokens' | 'unknown' =
                        dim === 'requests' || dim === 'tokens' ? dim : 'unknown';
                    return { status: 'rate_limited' as const, retryAfterSeconds, limitDimension };
                }

                // 413: input too large (per-request token cap). Return structured result so
                // the use case can show "start a new conversation" — never retry (plan D).
                if (error.response.status === 413) {
                    const body = error.response.data as {
                        errors?: { max_input_tokens?: number };
                    };
                    const maxInputTokens = body?.errors?.max_input_tokens ?? null;
                    return { status: 'input_too_large' as const, maxInputTokens };
                }

                const detail = typeof error.response.data === 'string'
                    ? error.response.data
                    : JSON.stringify(error.response.data);
                throw new Error(`tutor API ${error.response.status}: ${detail}`);
            }
            throw error;   // connection refused / timeout / non-HTTP → propagate unchanged
        }

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
