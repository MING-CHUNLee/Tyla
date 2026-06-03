/**
 * Unit Tests: TutorChatGateway — Option B request/response wiring.
 *
 * axios + the user profile are mocked; provider resolution is forced via env so no
 * real network / disk / key lookup happens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { TutorChatGateway } from '../../../src/infrastructure/api/tutor/tutor-chat-gateway';

vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('../../../src/infrastructure/config/profile', () => ({
    getProfile: vi.fn(() => ({ studentId: 's1', courseId: 'c1', projectId: 'p1' })),
}));

const mockPost = axios.post as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
    mockPost.mockReset();
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
