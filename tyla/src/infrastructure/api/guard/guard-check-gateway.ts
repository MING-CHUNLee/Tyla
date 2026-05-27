/**
 * Gateway: GuardCheckGateway
 *
 * Calls POST /api/v1/guard_checks on the Tyla-api backend.
 * The backend runs the LLM judge and writes the result to the database;
 * the frontend only needs to forward the prompt and act on `allowed`.
 *
 * Fail-open: any network or HTTP error allows the prompt through so the
 * tutor pipeline is never blocked by a guard outage.
 */

import axios from 'axios';
import { IGuardAgent, GuardResult, GuardLogEntry } from '../../../domain/types/guard-agent';
import type { TutorStyle } from '../../../application/use-cases/execute-tutor-use-case';
import { getEnv, detectProvider, getApiKeyForProvider, getEndpointForProvider, ENV_VARS } from '../../config';
import { getProfile } from '../../config/profile';
import { TYLA_API } from '../../config/constants';

// ── Wire types ────────────────────────────────────────────────────────────────

interface GuardCheckResponse {
    log_id: number;
    allowed: boolean;
    attack_probability: number | null;
    evaluation: string;
    refusal?: string;
    warning?: string;
}

// ── Gateway ───────────────────────────────────────────────────────────────────

export class GuardCheckGateway implements IGuardAgent {
    private readonly baseUrl: string;
    private readonly timeout: number;

    constructor(
        private readonly onJudgeError?: (message: string) => void,
        private readonly onLog?: (entry: GuardLogEntry) => void,
        private readonly directory?: string,
    ) {
        this.baseUrl = `http://${TYLA_API.HOST}:${TYLA_API.PORT}`;
        this.timeout = TYLA_API.DEFAULT_TIMEOUT_MS;
    }

    async check(userPrompt: string, _policyText: string, _style: TutorStyle): Promise<GuardResult> {
        const profile  = getProfile(this.directory);
        const provider = detectProvider();

        if (!profile) {
            this.onJudgeError?.('guard-api: profile.json missing, skipping guard');
            return { allowed: true, reason: 'profile-missing, allowed by default' };
        }

        let apiKey = '';
        try {
            apiKey = getApiKeyForProvider(provider);
        } catch {
            this.onJudgeError?.('guard-api: could not resolve LLM key, skipping guard');
            return { allowed: true, reason: 'llm-key-missing, allowed by default' };
        }

        try {
            const response = await axios.post<GuardCheckResponse>(
                `${this.baseUrl}/api/v1/guard_checks`,
                {
                    course_id:  profile.courseId,
                    project_id: profile.projectId,
                    student_id: profile.studentId,
                    prompt:     userPrompt,
                },
                {
                    timeout: this.timeout,
                    headers: {
                        'Content-Type':    'application/json',
                        'X-LLM-Key':       apiKey,
                        'X-LLM-Provider':  provider,
                        'X-LLM-Endpoint':  getEndpointForProvider(provider),
                        'X-LLM-Model':     getEnv(ENV_VARS.LLM_MODEL) ?? '',
                    },
                    // Accept both 200 (normal) and 202 (fail-open) as non-error
                    validateStatus: (status) => status === 200 || status === 202,
                },
            );

            const { allowed, attack_probability, evaluation, refusal, warning } = response.data;

            // 202 = guard skipped (LLM judge unavailable on backend)
            if (response.status === 202) {
                this.onJudgeError?.(`guard skipped: ${warning ?? 'llm unavailable'}`);
                return { allowed: true, reason: 'llm-unavailable' };
            }

            const probability = attack_probability !== null
                ? { attack: attack_probability, benign: 1 - attack_probability }
                : undefined;

            this.onLog?.({
                timestamp: new Date().toISOString(),
                userPrompt,
                probability: probability ?? { attack: 0, benign: 1 },
                reason: evaluation,
                allowed,
            });

            if (!allowed) {
                return {
                    allowed:             false,
                    reason:              evaluation,
                    probability,
                    action:              'refuse',
                    refusalInstruction:  refusal ?? evaluation,
                };
            }

            return { allowed: true, reason: evaluation, probability };
        } catch (err) {
            this.onJudgeError?.(`guard-api failed: ${String(err)}`);
            return { allowed: true, reason: 'guard-api unavailable, allowed by default' };
        }
    }
}
