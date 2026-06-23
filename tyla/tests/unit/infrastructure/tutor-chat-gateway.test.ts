/**
 * Unit Tests: TutorChatGateway — Option B request/response wiring.
 *
 * axios + the user profile are mocked; provider resolution is forced via env so no
 * real network / disk / key lookup happens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { TutorChatGateway } from '../../../src/infrastructure/api/tutor/tutor-chat-gateway';
import { debugLog } from '../../../src/infrastructure/api/shared/debug-log';

// isAxiosError mirrors the real axios guard (checks the `isAxiosError` marker) so the
// gateway's catch branch fires for our synthetic rejections.
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

const VALID_ACTION = { type: 'edit_file', path: 'hw11.R', patches: [{ search: 'a', replace: 'b' }] };
const MALFORMED_ACTION = { type: 'edit_file', path: 'hw11.R', patches: [{ search: 'a' }] };

describe('TutorChatGateway.send', () => {
    it('includes guard_log_id and file_context in the request body', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 1, status: 'done', content: 'ok', actions: [], usage: { input_tokens: 1, output_tokens: 2 } },
        });
        const gw = new TutorChatGateway();

        await gw.send('hello', [], 99, 'FILE-CONTEXT');

        const body = mockPost.mock.calls[0][1];
        expect(body.guard_log_id).toBe(99);
        expect(body.file_context).toBe('FILE-CONTEXT');
    });

    it('omits file_context when none is provided', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 1, status: 'done', content: 'ok', actions: [], usage: null },
        });
        const gw = new TutorChatGateway();

        await gw.send('hello', [], 5);

        const body = mockPost.mock.calls[0][1];
        expect('file_context' in body).toBe(false);
    });

    it('includes workspace_overview in the request body when provided (plan 2026-06-12 §4)', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 1, status: 'done', content: 'ok', actions: [], usage: null },
        });
        const gw = new TutorChatGateway();

        await gw.send('hello', [], 7, undefined, 'WORKSPACE-OVERVIEW');

        const body = mockPost.mock.calls[0][1];
        expect(body.workspace_overview).toBe('WORKSPACE-OVERVIEW');
        expect('file_context' in body).toBe(false);
    });

    it('omits workspace_overview when none is provided', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 1, status: 'done', content: 'ok', actions: [], usage: null },
        });
        const gw = new TutorChatGateway();

        await gw.send('hello', [], 5, 'FILE-CONTEXT');

        const body = mockPost.mock.calls[0][1];
        expect('workspace_overview' in body).toBe(false);
    });

    it('includes session_turns in the request body when provided (Option C §2.2)', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 1, status: 'done', content: 'ok', actions: [], usage: null },
        });
        const gw = new TutorChatGateway();
        const sessionTurns = [{ prompt: 'why?', prose: 'because', context_headers: '### a.R' }];

        await gw.send('hello', [], 5, undefined, undefined, sessionTurns);

        const body = mockPost.mock.calls[0][1];
        expect(body.session_turns).toEqual(sessionTurns);
    });

    it('omits session_turns when none / empty is provided (first turn)', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 1, status: 'done', content: 'ok', actions: [], usage: null },
        });
        const gw = new TutorChatGateway();

        await gw.send('hello', [], 5);
        await gw.send('hello', [], 5, undefined, undefined, []);

        expect('session_turns' in mockPost.mock.calls[0][1]).toBe(false);
        expect('session_turns' in mockPost.mock.calls[1][1]).toBe(false);
    });

    it('filters actions through isTutorAction (one valid + one malformed → length 1)', async () => {
        mockPost.mockResolvedValue({
            data: {
                log_id: 1, status: 'done', content: 'ok',
                actions: [VALID_ACTION, MALFORMED_ACTION],
                usage: { input_tokens: 1, output_tokens: 2 },
            },
        });
        const gw = new TutorChatGateway();

        const result = await gw.send('hello', [], 1);

        expect(result.status).toBe('done');
        if (result.status === 'done' || result.status === 'unavailable') {
            expect(result.actions).toHaveLength(1);
            expect(result.actions[0].type).toBe('edit_file');
        }
    });

    it('forbidden carries no actions', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 2, status: 'forbidden', content: 'blocked', usage: null },
        });
        const gw = new TutorChatGateway();

        const result = await gw.send('hello', [], 1);

        expect(result.status).toBe('forbidden');
        expect('actions' in result).toBe(false);
    });

    it('parses warnings into the done result (plan 2026-06-11 §2.7)', async () => {
        mockPost.mockResolvedValue({
            data: {
                log_id: 1, status: 'done', content: 'ok', actions: [],
                usage: { input_tokens: 1, output_tokens: 2 },
                warnings: ['file_context_dropped', 'history_truncated'],
            },
        });
        const gw = new TutorChatGateway();

        const result = await gw.send('hello', [], 1);

        expect(result.status).toBe('done');
        if (result.status === 'done' || result.status === 'unavailable') {
            expect(result.warnings).toEqual(['file_context_dropped', 'history_truncated']);
        }
    });

    it('defaults warnings to [] when the field is missing (older backend)', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 1, status: 'done', content: 'ok', actions: [], usage: null },
        });
        const gw = new TutorChatGateway();

        const result = await gw.send('hello', [], 1);

        if (result.status === 'done' || result.status === 'unavailable') {
            expect(result.warnings).toEqual([]);
        }
    });

    it('drops non-string entries from warnings', async () => {
        mockPost.mockResolvedValue({
            data: {
                log_id: 1, status: 'done', content: 'ok', actions: [], usage: null,
                warnings: ['file_context_dropped', 42, null],
            },
        });
        const gw = new TutorChatGateway();

        const result = await gw.send('hello', [], 1);

        if (result.status === 'done' || result.status === 'unavailable') {
            expect(result.warnings).toEqual(['file_context_dropped']);
        }
    });

    it('error carries no actions and surfaces the content', async () => {
        mockPost.mockResolvedValue({
            data: { log_id: 3, status: 'error', content: 'server boom', usage: null },
        });
        const gw = new TutorChatGateway();

        const result = await gw.send('hello', [], 1);

        expect(result.status).toBe('error');
        expect('actions' in result).toBe(false);
        if (result.status === 'error') expect(result.content).toBe('server boom');
    });
});

// ── Backend error diagnostics (plan 2026-06-16 §3.2) ───────────────────────────
// A non-whitelisted status makes axios throw before the success-path RESPONSE log;
// the catch branch must record the backend body and rethrow with that detail.

describe('TutorChatGateway.send — AxiosError diagnostics', () => {
    it('logs the backend response body and throws a message carrying status + detail on 400', async () => {
        mockPost.mockRejectedValue(axiosError(400, { detail: 'assistant content cannot be empty' }));
        const gw = new TutorChatGateway();

        await expect(gw.send('hello', [], 1)).rejects.toThrow(/tutor API 400/);

        // RESPONSE was logged with the backend body even though axios threw early.
        const responseCall = mockDebugLog.mock.calls.find(c => c[0] === 'tutor' && c[1] === 'RESPONSE');
        expect(responseCall).toBeTruthy();
        expect(responseCall![2]).toMatchObject({
            httpStatus: 400,
            body: { detail: 'assistant content cannot be empty' },
        });
    });

    it('folds the backend detail into the thrown message (not the generic axios string)', async () => {
        mockPost.mockRejectedValue(axiosError(422, { detail: 'history[1].content must not be blank' }));
        const gw = new TutorChatGateway();

        await expect(gw.send('hi', [], 1)).rejects.toThrow(/history\[1\]\.content must not be blank/);
    });

    it('rethrows a non-HTTP error (timeout / ECONNREFUSED) unchanged and logs no RESPONSE', async () => {
        // AxiosError with no `response` — connection refused / timeout.
        const conn = Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true });
        mockPost.mockRejectedValue(conn);
        const gw = new TutorChatGateway();

        await expect(gw.send('hi', [], 1)).rejects.toBe(conn);
        expect(mockDebugLog.mock.calls.some(c => c[1] === 'RESPONSE')).toBe(false);
    });
});

// ── 429 provider rate limit (plan 2026-06-18 §6, C) ────────────────────────────
// A 429 is not whitelisted, so axios throws into the catch branch; the gateway must
// turn it into a structured `rate_limited` result (not a generic thrown Error) so the
// use case can render the "wait & retry" back-off guidance.

describe('TutorChatGateway.send — 429 rate limit', () => {
    it('returns rate_limited result when backend returns 429', async () => {
        mockPost.mockRejectedValue(axiosError(429, {
            status: 'rate_limited',
            errors: { retry_after: '30', limit_dimension: 'requests' },
        }));
        const gw = new TutorChatGateway();
        const result = await gw.send('hi', [], 1);
        expect(result.status).toBe('rate_limited');
        expect((result as { retryAfterSeconds: number }).retryAfterSeconds).toBe(30);
        expect((result as { limitDimension: string }).limitDimension).toBe('requests');
    });

    it('handles 429 with no retry_after', async () => {
        mockPost.mockRejectedValue(axiosError(429, { status: 'rate_limited', errors: {} }));
        const gw = new TutorChatGateway();
        const result = await gw.send('hi', [], 1);
        expect(result.status).toBe('rate_limited');
        expect((result as { retryAfterSeconds: number | null }).retryAfterSeconds).toBeNull();
        expect((result as { limitDimension: string }).limitDimension).toBe('unknown');
    });

    it('still throws for non-429 errors (e.g. 502)', async () => {
        mockPost.mockRejectedValue(axiosError(502, 'bad gateway'));
        const gw = new TutorChatGateway();
        await expect(gw.send('hi', [], 1)).rejects.toThrow('tutor API 502');
    });

    it('rate_limited result does not include log_id or content', async () => {
        mockPost.mockRejectedValue(axiosError(429, { errors: { retry_after: '10' } }));
        const gw = new TutorChatGateway();
        const result = await gw.send('hi', [], 1);
        expect(result).not.toHaveProperty('logId');
        expect(result).not.toHaveProperty('content');
    });
});
