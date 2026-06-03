import axios from 'axios';
import { TutorAction, isTutorAction } from '../../../shared/types/tutor-actions';
import { SessionMessage } from '../../../shared/types/messages';
import { TYLA_API } from '../../config/constants';
import { buildTylaApiRequest } from '../shared/build-llm-headers';
import { parseUsage, Usage } from '../shared/parse-usage';

// ── Wire types ────────────────────────────────────────────────────────────────

interface TutorChatResponse {
    log_id: number;
    status: 'done' | 'forbidden' | 'error' | 'unavailable';   // unified ApiStatus
    content: string;
    actions?: unknown[];          // validated → TutorAction[] in send()
    usage: { input_tokens: number; output_tokens: number } | null;
}

// ── Domain result ─────────────────────────────────────────────────────────────

export type TutorChatResult =
    | { status: 'done' | 'unavailable'; logId: number; content: string; actions: TutorAction[]; usage: Usage; guardSkipped: boolean }
    | { status: 'forbidden';            logId: number; content: string; usage: Usage }
    | { status: 'error';                logId: number; content: string; usage: Usage };

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

    async send(
        prompt: string,
        history: SessionMessage[],
        guardLogId: number,
        fileContext?: string,
    ): Promise<TutorChatResult> {
        const { profile, headers } = buildTylaApiRequest('tutor-api', this.directory);

        const response = await axios.post<TutorChatResponse>(
            `${this.baseUrl}/api/v1/tutor_chats`,
            {
                course_id:  profile.courseId,
                project_id: profile.projectId,
                student_id: profile.studentId,
                guard_log_id: guardLogId,
                prompt,
                history,
                ...(fileContext ? { file_context: fileContext } : {}),
            },
            {
                timeout: this.timeout,
                headers,
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

        if (data.status === 'error') {
            return {
                status:  'error',
                logId:   data.log_id,
                content: data.content,
                usage:   parseUsage(data.usage),
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

        return {
            status:      data.status,
            logId:       data.log_id,
            content:     data.content,
            actions,
            guardSkipped,
            usage: parseUsage(data.usage),
        };
    }
}
