/**
 * Unit Tests: GuardCheckGateway — Option B pre-call.
 *
 * axios + the user profile are mocked; provider resolution is forced via env.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { GuardCheckGateway } from '../../../src/infrastructure/api/guard/guard-check-gateway';
import { debugLog } from '../../../src/infrastructure/api/shared/debug-log';

// isAxiosError mirrors the real axios guard so the gateway's catch branch fires for
// our synthetic rejections.
vi.mock('axios', () => ({
    default: { post: vi.fn() },
    isAxiosError: (e: unknown): boolean =>
        !!e && typeof e === 'object' && (e as { isAxiosError?: boolean }).isAxiosError === true,
}));
vi.mock('../../../src/infrastructure/api/shared/debug-log', () => ({ debugLog: vi.fn() }));
vi.mock('../../../src/infrastructure/config/profile', () => ({
    getProfile: vi.fn(() => ({ studentId: 's1', courseId: 'c1', projectId: 'p1' })),
}));

const mockPost = axios.post as unknown as ReturnType<typeof vi.fn>;
const mockDebugLog = debugLog as unknown as ReturnType<typeof vi.fn>;

/** AxiosError-shaped rejection carrying a backend HTTP response. */
function axiosError(status: number, data: unknown) {
    return { isAxiosError: true, message: `Request failed with status code ${status}`, response: { status, data } };
}

beforeEach(() => {
    mockPost.mockReset();
    mockDebugLog.mockReset();
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
});

describe('GuardCheckGateway.check', () => {
    it('maps status "done" to a done result with logId', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 42, status: 'done', refusal: null, usage: { input_tokens: 5, output_tokens: 0 } },
        });
        const gw = new GuardCheckGateway();

        const result = await gw.check('explain recursion');

        expect(result.status).toBe('done');
        if (result.status === 'done' || result.status === 'unavailable') {
            expect(result.logId).toBe(42);
            expect(result.guardSkipped).toBe(false);
        }
    });

    it('maps status "forbidden" to a forbidden result carrying the refusal', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 7, status: 'forbidden', refusal: 'Cannot help with that.', usage: null },
        });
        const gw = new GuardCheckGateway();

        const result = await gw.check('do my exam');

        expect(result.status).toBe('forbidden');
        if (result.status === 'forbidden') {
            expect(result.logId).toBe(7);
            expect(result.refusal).toBe('Cannot help with that.');
        }
    });

    it('maps status "error" to an error result with a message and no logId', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 0, status: 'error', refusal: 'judge unavailable', usage: null },
        });
        const gw = new GuardCheckGateway();

        const result = await gw.check('hi');

        expect(result.status).toBe('error');
        if (result.status === 'error') {
            expect(result.message).toBe('judge unavailable');
            expect('logId' in result).toBe(false);
        }
    });

    it('maps status "unavailable" to guardSkipped and warns', async () => {
        const onWarning = vi.fn();
        mockPost.mockResolvedValue({
            data: { log_id: 9, status: 'unavailable', refusal: null, usage: null },
        });
        const gw = new GuardCheckGateway(onWarning);

        const result = await gw.check('hi');

        expect(result.status).toBe('unavailable');
        if (result.status === 'done' || result.status === 'unavailable') {
            expect(result.guardSkipped).toBe(true);
        }
        expect(onWarning).toHaveBeenCalled();
    });

    it('clamps invalid usage values to 0', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 1, status: 'done', refusal: null, usage: { input_tokens: -5, output_tokens: 9e9 } },
        });
        const gw = new GuardCheckGateway();

        const result = await gw.check('hi');

        expect(result.usage.inputTokens).toBe(0);
        expect(result.usage.outputTokens).toBe(0);
    });
});

// ── Backend error diagnostics (plan 2026-06-16 §3.2) ───────────────────────────

describe('GuardCheckGateway.check — AxiosError diagnostics', () => {
    it('logs the backend response body and throws a message carrying status + detail on 400', async () => {
        mockPost.mockRejectedValue(axiosError(400, { detail: 'missing course_id' }));
        const gw = new GuardCheckGateway();

        await expect(gw.check('hello')).rejects.toThrow(/guard API 400/);

        const responseCall = mockDebugLog.mock.calls.find(c => c[0] === 'guard' && c[1] === 'RESPONSE');
        expect(responseCall).toBeTruthy();
        expect(responseCall![2]).toMatchObject({ httpStatus: 400, body: { detail: 'missing course_id' } });
    });

    it('folds the backend detail into the thrown message', async () => {
        mockPost.mockRejectedValue(axiosError(422, { detail: 'prompt must not be empty' }));
        const gw = new GuardCheckGateway();

        await expect(gw.check('hi')).rejects.toThrow(/prompt must not be empty/);
    });

    it('rethrows a non-HTTP error (timeout / ECONNREFUSED) unchanged and logs no RESPONSE', async () => {
        const conn = Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true });
        mockPost.mockRejectedValue(conn);
        const gw = new GuardCheckGateway();

        await expect(gw.check('hi')).rejects.toBe(conn);
        expect(mockDebugLog.mock.calls.some(c => c[1] === 'RESPONSE')).toBe(false);
    });
});
