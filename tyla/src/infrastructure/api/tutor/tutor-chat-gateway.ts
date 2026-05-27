import axios from 'axios';
import { SessionMessage } from '../../../shared/types/messages';
import { getEnv, detectProvider, getApiKeyForProvider, getEndpointForProvider, ENV_VARS } from '../../config';
import { getProfile } from '../../config/profile';
import { TYLA_API } from '../../config/constants';

// ── Wire types ────────────────────────────────────────────────────────────────

interface TutorChatResponse {
    log_id: number;
    allowed: boolean;
    content?: string;
    usage?: { input_tokens: number; output_tokens: number };
    refusal?: string;
    attack_probability?: number;
    evaluation?: string;
    warning?: string;
}

// ── Domain result ─────────────────────────────────────────────────────────────

export type TutorChatResult =
    | { allowed: true;  logId: number; content: string; usage: { inputTokens: number; outputTokens: number }; warning?: string }
    | { allowed: false; logId: number; refusal: string; attackProbability: number; evaluation: string };

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

        if (!data.allowed) {
            return {
                allowed:           false,
                logId:             data.log_id,
                refusal:           data.refusal ?? data.evaluation ?? 'Request blocked.',
                attackProbability: data.attack_probability ?? 1,
                evaluation:        data.evaluation ?? '',
            };
        }

        if (response.status === 202) {
            this.onWarning?.(`guard skipped: ${data.warning ?? 'llm unavailable'}`);
        }

        return {
            allowed: true,
            logId:   data.log_id,
            content: data.content ?? '',
            usage: {
                inputTokens:  data.usage?.input_tokens  ?? 0,
                outputTokens: data.usage?.output_tokens ?? 0,
            },
            ...(data.warning ? { warning: data.warning } : {}),
        };
    }
}
