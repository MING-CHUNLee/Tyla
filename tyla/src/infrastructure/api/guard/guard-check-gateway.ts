/**
 * GuardCheckGateway — HTTP client for the Option B safety pre-call (POST /api/v1/guard_checks).
 *
 * Near-verbatim mirror of TutorChatGateway: same headers, same profile/provider resolution.
 * Only the path, the response shape, and the result union differ. Returns a discriminated
 * GuardCheckResult; the caller (ExecuteTutorUseCase) decides forbidden/error/done handling.
 */

import axios, { AxiosResponse, isAxiosError } from 'axios';
import { TYLA_API } from '../../config/constants';
import { buildTylaApiRequest } from '../shared/build-llm-headers';
import { parseUsage, Usage } from '../shared/parse-usage';
import { debugLog } from '../shared/debug-log';

// ── Wire types ────────────────────────────────────────────────────────────────

// Unified ApiStatus enum (decision doc §3.1) — shared by guard_checks and tutor_chats.
interface GuardCheckResponse {
    log_id: number;
    status: 'done' | 'forbidden' | 'error' | 'unavailable';
    refusal: string | null;
    usage: { input_tokens: number; output_tokens: number } | null;
}

// ── Domain result ─────────────────────────────────────────────────────────────

/** Raw HTTP request/response bodies captured for session audit log. */
export interface GuardRawExchange {
    requestBody: unknown;
    requestAt: string;
    responseBody: unknown;
    responseAt: string;
}

export type GuardCheckResult =
    | { status: 'done' | 'unavailable'; logId: number; guardSkipped: boolean; usage: Usage; rawExchange?: GuardRawExchange }
    | { status: 'forbidden';            logId: number; refusal: string;        usage: Usage; rawExchange?: GuardRawExchange }
    | { status: 'error';                message: string;                       usage: Usage; rawExchange?: GuardRawExchange };

// ── Gateway ───────────────────────────────────────────────────────────────────

export class GuardCheckGateway {
    private readonly baseUrl: string;
    private readonly timeout: number;

    constructor(
        private readonly onWarning?: (message: string) => void,
        private readonly directory?: string,
    ) {
        this.baseUrl = `http://${TYLA_API.HOST}:${TYLA_API.PORT}`;
        this.timeout = TYLA_API.DEFAULT_TIMEOUT_MS;
    }

    /** Run the safety pre-call on the student's prompt only (no file_context — saves judge tokens). */
    async check(prompt: string): Promise<GuardCheckResult> {
        const { profile, headers } = buildTylaApiRequest('guard-api', this.directory);

        const body = {
            course_id:  profile.courseId,
            project_id: profile.projectId,
            student_id: profile.studentId,
            prompt,
        };
        const requestAt = new Date().toISOString();
        debugLog('guard', 'REQUEST', body);

        let response: AxiosResponse<GuardCheckResponse>;
        try {
            response = await axios.post<GuardCheckResponse>(
                `${this.baseUrl}/api/v1/guard_checks`,
                body,
                {
                    timeout: this.timeout,
                    headers,
                    // WS-A: status lives in the body, HTTP is always 200 (only malformed
                    // request / missing key → 4xx). Keep 202 accepted for the pre-WS-A bridge.
                    validateStatus: (status) => status === 200 || status === 202,
                },
            );
        } catch (error) {
            // A non-whitelisted status (e.g. a 400 request-validation reject) makes axios
            // throw HERE — before the RESPONSE log below — so without this catch the failure
            // leaves a REQUEST with no matching RESPONSE in debug.log (plan 2026-06-16 §1.4).
            // Capture the backend's real error body, then rethrow with that detail folded in;
            // the bare AxiosError string hides which field the backend rejected.
            if (isAxiosError(error) && error.response) {
                debugLog('guard', 'RESPONSE', {
                    httpStatus: error.response.status,
                    body: error.response.data,
                });
                const detail = typeof error.response.data === 'string'
                    ? error.response.data
                    : JSON.stringify(error.response.data);
                throw new Error(`guard API ${error.response.status}: ${detail}`);
            }
            throw error;   // connection refused / timeout / non-HTTP → propagate unchanged
        }

        const data = response.data;
        const responseAt = new Date().toISOString();
        debugLog('guard', 'RESPONSE', data);
        const rawExchange: GuardRawExchange = { requestBody: body, requestAt, responseBody: data, responseAt };

        if (data.status === 'forbidden') {
            return { status: 'forbidden', logId: data.log_id, refusal: data.refusal ?? '', usage: parseUsage(data.usage), rawExchange };
        }

        // decision doc §3.1: backend/judge error → surface to student, suggest retry.
        // No valid log_id is produced, so the turn must NOT proceed to tutor_chats.
        if (data.status === 'error') {
            return { status: 'error', message: data.refusal ?? 'guard check failed', usage: parseUsage(data.usage), rawExchange };
        }

        const guardSkipped = data.status === 'unavailable';
        if (guardSkipped) {
            this.onWarning?.('guard skipped: llm unavailable');
        }

        return { status: data.status, logId: data.log_id, guardSkipped, usage: parseUsage(data.usage), rawExchange };
    }
}
