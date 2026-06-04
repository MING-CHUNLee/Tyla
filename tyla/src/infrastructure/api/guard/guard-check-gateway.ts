/**
 * GuardCheckGateway — HTTP client for the Option B safety pre-call (POST /api/v1/guard_checks).
 *
 * Near-verbatim mirror of TutorChatGateway: same headers, same profile/provider resolution.
 * Only the path, the response shape, and the result union differ. Returns a discriminated
 * GuardCheckResult; the caller (ExecuteTutorUseCase) decides forbidden/error/done handling.
 */

import axios from 'axios';
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

export type GuardCheckResult =
    | { status: 'done' | 'unavailable'; logId: number; guardSkipped: boolean; usage: Usage }
    | { status: 'forbidden';            logId: number; refusal: string;        usage: Usage }
    | { status: 'error';                message: string;                       usage: Usage };

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
        debugLog('guard', 'REQUEST', body);

        const response = await axios.post<GuardCheckResponse>(
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

        const data = response.data;
        debugLog('guard', 'RESPONSE', data);

        if (data.status === 'forbidden') {
            return { status: 'forbidden', logId: data.log_id, refusal: data.refusal ?? '', usage: parseUsage(data.usage) };
        }

        // decision doc §3.1: backend/judge error → surface to student, suggest retry.
        // No valid log_id is produced, so the turn must NOT proceed to tutor_chats.
        if (data.status === 'error') {
            return { status: 'error', message: data.refusal ?? 'guard check failed', usage: parseUsage(data.usage) };
        }

        const guardSkipped = data.status === 'unavailable';
        if (guardSkipped) {
            this.onWarning?.('guard skipped: llm unavailable');
        }

        return { status: data.status, logId: data.log_id, guardSkipped, usage: parseUsage(data.usage) };
    }
}
