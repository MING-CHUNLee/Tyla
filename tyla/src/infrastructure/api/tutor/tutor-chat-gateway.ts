import axios from 'axios';
import { SessionMessage } from '../../../shared/types/messages';
import { getEnv, detectProvider, getApiKeyForProvider, getEndpointForProvider, ENV_VARS } from '../../config';
import { getProfile } from '../../config/profile';
import { TYLA_API } from '../../config/constants';

// ── Wire types ────────────────────────────────────────────────────────────────

interface TutorChatResponse {
    log_id: number;
    status: 'done' | 'forbidden' | 'unavailable';
    content: string;
    usage: { input_tokens: number; output_tokens: number } | null;
}

// ── Domain result ─────────────────────────────────────────────────────────────

export type TutorChatResult =
    | { status: 'done' | 'unavailable'; logId: number; content: string; usage: { inputTokens: number; outputTokens: number }; guardSkipped: boolean }
    | { status: 'forbidden';            logId: number; content: string; usage: { inputTokens: number; outputTokens: number } };

// Returns validated non-negative integers; falls back to 0 on invalid.
function parseUsage(raw: { input_tokens: number; output_tokens: number } | null | undefined)
    : { inputTokens: number; outputTokens: number } {
    const MAX = 1_000_000;
    const safe = (n: unknown): number =>
        typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX ? n : 0;
    return { inputTokens: safe(raw?.input_tokens), outputTokens: safe(raw?.output_tokens) };
}

// ── Gateway ───────────────────────────────────────────────────────────────────

export class TutorChatGateway {
    private readonly baseUrl: string;
    private readonly timeout: number;

    constructor(
        private readonly onWarning?: (message: string) => void,
        private readonly directory?: string,
    ) {
        this.baseUrl = `http://${TYLA_API.HOST}:${TYLA_API.PORT}`;
        this.timeout = TYLA_API.DEFAULT_TIMEOUT_MS;
    }

    async send(prompt: string, history: SessionMessage[]): Promise<TutorChatResult> {
        const profile  = getProfile(this.directory);
        const provider = detectProvider();

        if (!profile) {
            throw new Error('tutor-api: profile.json missing');
        }

        let apiKey: string;
        try {
            apiKey = getApiKeyForProvider(provider);
        } catch {
            throw new Error('tutor-api: could not resolve LLM key');
        }

        const response = await axios.post<TutorChatResponse>(
            `${this.baseUrl}/api/v1/tutor_chats`,
            {
                course_id:  profile.courseId,
                project_id: profile.projectId,
                student_id: profile.studentId,
                prompt,
                history,
            },
            {
                timeout: this.timeout,
                headers: {
                    'Content-Type':   'application/json',
                    'X-LLM-Key':      apiKey,
                    'X-LLM-Provider': provider,
                    'X-LLM-Endpoint': getEndpointForProvider(provider),
                    'X-LLM-Model':    getEnv(ENV_VARS.LLM_MODEL) ?? '',
                },
                validateStatus: (status) => status === 200 || status === 202,
            },
        );

        const data = response.data;

        if (data.status === 'forbidden') {
            return {
                status:  'forbidden',
                logId:   data.log_id,
                content: data.content,
                usage:   parseUsage(data.usage),
            };
        }

        const guardSkipped = data.status === 'unavailable';
        if (guardSkipped) {
            this.onWarning?.('guard skipped: llm unavailable');
        }

        return {
            status:      data.status,
            logId:       data.log_id,
            content:     data.content,
            guardSkipped,
            usage: parseUsage(data.usage),
        };
    }
}
