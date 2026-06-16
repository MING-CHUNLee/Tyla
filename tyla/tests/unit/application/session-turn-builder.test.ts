/**
 * Unit Tests: session-turn builder (plan Option C §7 — frontend switchover).
 *
 * The builder only EXTRACTS materials (prompt / prose / headers-only block /
 * terminal actions) — compression, caps, placeholder wording and seen_paths
 * parsing all live in the backend HistoryTurnSerializer, so they are NOT asserted
 * here. What we guard: correct convergence on the terminal req/resp, the
 * headers-only transform, malformed-action filtering, and graceful degrade.
 */

import { describe, it, expect } from 'vitest';
import { buildSessionTurn, buildSessionTurns } from '../../../src/application/services/session-turn-builder';
import { ConversationTurn, ApiLogEntry } from '../../../src/domain/entities/conversation-turn';
import { ConversationSession } from '../../../src/domain/entities/conversation-session';

const ZERO = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

function req(file_context: string): ApiLogEntry {
    return { timestamp: 't', source: 'tutor', direction: 'request', payload: { file_context } };
}
function resp(actions: unknown[]): ApiLogEntry {
    return { timestamp: 't', source: 'tutor', direction: 'response', payload: { actions } };
}
function turn(userMessage: string, assistantMessage: string, apiLogs: ApiLogEntry[]): ConversationTurn {
    return new ConversationTurn(1, userMessage, assistantMessage, ZERO, undefined, [], [], apiLogs);
}

const EDIT_ACTION = { type: 'edit_file', path: 'hw2.R', patches: [{ start_line: 8, search: '0.50', replace: '0.5' }] };

describe('buildSessionTurn', () => {
    it('extracts prompt, prose, headers-only block and terminal actions', () => {
        const t = turn(
            'why is my mean wrong?',
            'Check your rounding.',
            [
                req('### hw2.R\n1| library(ggplot2)\n2| m <- mean(x)\n\n'),
                resp([EDIT_ACTION]),
            ],
        );

        const st = buildSessionTurn(t);

        expect(st.prompt).toBe('why is my mean wrong?');
        expect(st.prose).toBe('Check your rounding.');
        expect(st.context_headers).toBe('### hw2.R');   // numbered content stripped
        expect(st.actions).toEqual([EDIT_ACTION]);
    });

    it('converges a B3 continuation turn on the LAST request + LAST response', () => {
        // file_context accumulates monotonically across continuations (§3.2): the last
        // request already holds the union, and the last response is the terminal reply.
        const t = turn(
            'fix both files',
            'Here is the final hint.',
            [
                req('### a.R\n1| x\n\n'),
                resp([{ type: 'load_file', path: 'b.R' }]),
                req('### a.R\n1| x\n\n### b.R\n1| y\n\n'),
                resp([EDIT_ACTION]),
            ],
        );

        const st = buildSessionTurn(t);

        expect(st.context_headers).toBe('### a.R\n### b.R');   // union from terminal request
        expect(st.actions).toEqual([EDIT_ACTION]);            // terminal response only
    });

    it('omits prose for an action-only turn (assistantMessage is "")', () => {
        const t = turn('', '', [req('### hw2.R\n1| x\n\n'), resp([EDIT_ACTION])]);
        // empty userMessage stays as-is (backend contract-saves); we just must not invent prose.
        const st = buildSessionTurn(t);
        expect('prose' in st).toBe(false);
        expect(st.actions).toEqual([EDIT_ACTION]);
    });

    it('keeps load_file actions (backend render table handles a terminal load_file)', () => {
        const t = turn('show me utils', '', [req(''), resp([{ type: 'load_file', path: 'utils.R' }])]);
        const st = buildSessionTurn(t);
        expect(st.actions).toEqual([{ type: 'load_file', path: 'utils.R' }]);
    });

    it('filters malformed actions through isTutorAction', () => {
        const malformed = { type: 'edit_file', path: 'hw2.R', patches: [{ search: 'a' }] }; // no replace
        const t = turn('q', 'a', [req(''), resp([EDIT_ACTION, malformed])]);
        const st = buildSessionTurn(t);
        expect(st.actions).toEqual([EDIT_ACTION]);
    });

    it('degrades to plain prompt+prose for a turn with no tutor apiLogs (ask/run/legacy)', () => {
        const t = turn('what is recursion?', 'A function that calls itself.', []);
        const st = buildSessionTurn(t);
        expect(st).toEqual({ prompt: 'what is recursion?', prose: 'A function that calls itself.' });
        expect('context_headers' in st).toBe(false);
        expect('actions' in st).toBe(false);
    });
});

describe('buildSessionTurns', () => {
    it('maps every prior turn in order, one SessionTurn each', () => {
        const session = ConversationSession.create('m');
        session.addTurn('first', 'reply one', ZERO, [], [], [req('### a.R\n1| x\n\n'), resp([])]);
        session.addTurn('second', 'reply two', ZERO);

        const turns = buildSessionTurns(session);

        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({ prompt: 'first', prose: 'reply one', context_headers: '### a.R' });
        expect(turns[1]).toEqual({ prompt: 'second', prose: 'reply two' });
    });
});
