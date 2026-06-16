/**
 * Tests: ConversationTurn backward-compat migration
 *
 * Verifies that session files written before the FileChange/LLMOutput split
 * (which stored everything as `artifacts: ArtifactJSON[]`) are correctly
 * deserialized into the new schema.
 */

import { describe, it, expect } from 'vitest';
import { ConversationTurn, TurnJSON } from '../../../src/domain/entities/conversation-turn';
import { FileChange } from '../../../src/domain/entities/file-change';
import { LLMOutput } from '../../../src/domain/values/llm-output';

const BASE_USAGE = {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
};

const TS = new Date('2025-01-01T00:00:00.000Z').toISOString();

// ── FileChange ─────────────────────────────────────────────────────────────────

describe('FileChange', () => {
    it('create() sets all fields correctly', () => {
        const fc = FileChange.create('edit', 'src/foo.ts', 'const x = 1;');
        expect(fc.type).toBe('edit');
        expect(fc.path).toBe('src/foo.ts');
        expect(fc.content).toBe('const x = 1;');
        expect(fc.id).toMatch(/^fc-/);
    });

    it('roundtrips through toJSON/fromJSON', () => {
        const original = FileChange.create('diff', 'src/bar.R', '- old\n+ new');
        const restored = FileChange.fromJSON(original.toJSON());
        expect(restored.type).toBe(original.type);
        expect(restored.path).toBe(original.path);
        expect(restored.content).toBe(original.content);
        expect(restored.id).toBe(original.id);
    });
});

// ── LLMOutput ─────────────────────────────────────────────────────────────────

describe('LLMOutput', () => {
    it('create() sets all fields correctly', () => {
        const out = LLMOutput.create('analysis', 'The code looks fine.');
        expect(out.type).toBe('analysis');
        expect(out.content).toBe('The code looks fine.');
        expect(out.id).toMatch(/^out-/);
        expect((out as unknown as Record<string, unknown>).path).toBeUndefined();
    });

    it('roundtrips through toJSON/fromJSON', () => {
        const original = LLMOutput.create('report', 'Summary here');
        const restored = LLMOutput.fromJSON(original.toJSON());
        expect(restored.type).toBe(original.type);
        expect(restored.content).toBe(original.content);
        expect(restored.id).toBe(original.id);
    });
});

// ── ConversationTurn migration ─────────────────────────────────────────────────

describe('ConversationTurn.fromJSON() — migration', () => {
    it('migrates legacy edit artifact → FileChange', () => {
        const data: TurnJSON = {
            turnNumber: 1,
            userMessage: 'fix it',
            assistantMessage: 'done',
            usage: BASE_USAGE,
            timestamp: TS,
            fileChanges: [],
            outputs: [],
            artifacts: [
                { id: 'art-1', type: 'edit', path: 'src/foo.ts', content: 'x=1', createdAt: TS },
            ],
        };
        const turn = ConversationTurn.fromJSON(data);
        expect(turn.fileChanges).toHaveLength(1);
        expect(turn.fileChanges[0].path).toBe('src/foo.ts');
        expect(turn.fileChanges[0].type).toBe('edit');
        expect(turn.outputs).toHaveLength(0);
    });

    it('migrates legacy diff artifact → FileChange', () => {
        const data: TurnJSON = {
            turnNumber: 1,
            userMessage: 'patch it',
            assistantMessage: 'done',
            usage: BASE_USAGE,
            timestamp: TS,
            fileChanges: [],
            outputs: [],
            artifacts: [
                { id: 'art-2', type: 'diff', path: 'src/bar.R', content: '- old\n+ new', createdAt: TS },
            ],
        };
        const turn = ConversationTurn.fromJSON(data);
        expect(turn.fileChanges).toHaveLength(1);
        expect(turn.fileChanges[0].type).toBe('diff');
        expect(turn.outputs).toHaveLength(0);
    });

    it('migrates legacy analysis artifact → LLMOutput', () => {
        const data: TurnJSON = {
            turnNumber: 1,
            userMessage: 'explain',
            assistantMessage: 'the code does X',
            usage: BASE_USAGE,
            timestamp: TS,
            fileChanges: [],
            outputs: [],
            artifacts: [
                { id: 'art-3', type: 'analysis', content: 'The code does X', createdAt: TS },
            ],
        };
        const turn = ConversationTurn.fromJSON(data);
        expect(turn.outputs).toHaveLength(1);
        expect(turn.outputs[0].type).toBe('analysis');
        expect(turn.fileChanges).toHaveLength(0);
    });

    it('migrates mixed legacy artifacts correctly', () => {
        const data: TurnJSON = {
            turnNumber: 1,
            userMessage: 'do stuff',
            assistantMessage: 'done',
            usage: BASE_USAGE,
            timestamp: TS,
            fileChanges: [],
            outputs: [],
            artifacts: [
                { id: 'a1', type: 'edit', path: 'a.ts', content: 'x', createdAt: TS },
                { id: 'a2', type: 'report', content: 'report text', createdAt: TS },
                { id: 'a3', type: 'code', content: 'const y = 2', createdAt: TS },
            ],
        };
        const turn = ConversationTurn.fromJSON(data);
        expect(turn.fileChanges).toHaveLength(1);
        expect(turn.outputs).toHaveLength(2);
    });

    it('reads new format without triggering migration', () => {
        const data: TurnJSON = {
            turnNumber: 1,
            userMessage: 'do something',
            assistantMessage: 'done',
            usage: BASE_USAGE,
            timestamp: TS,
            fileChanges: [
                { id: 'fc-1', type: 'edit', path: 'app.ts', content: 'new content', createdAt: TS },
            ],
            outputs: [],
        };
        const turn = ConversationTurn.fromJSON(data);
        expect(turn.fileChanges).toHaveLength(1);
        expect(turn.fileChanges[0].id).toBe('fc-1');
        expect(turn.outputs).toHaveLength(0);
    });

    it('handles empty session (no artifacts, no fileChanges, no outputs)', () => {
        const data: TurnJSON = {
            turnNumber: 1,
            userMessage: 'hi',
            assistantMessage: 'hello',
            usage: BASE_USAGE,
            timestamp: TS,
            fileChanges: [],
            outputs: [],
        };
        const turn = ConversationTurn.fromJSON(data);
        expect(turn.fileChanges).toHaveLength(0);
        expect(turn.outputs).toHaveLength(0);
    });

    it('roundtrips new format through toJSON/fromJSON', () => {
        const original = new ConversationTurn(
            1, 'user msg', 'assistant msg', BASE_USAGE, new Date(TS),
            [FileChange.create('edit', 'x.ts', 'content')],
            [LLMOutput.create('analysis', 'some analysis')],
        );
        const restored = ConversationTurn.fromJSON(original.toJSON());
        expect(restored.fileChanges).toHaveLength(1);
        expect(restored.outputs).toHaveLength(1);
        expect(restored.fileChanges[0].path).toBe('x.ts');
        expect(restored.outputs[0].type).toBe('analysis');
    });
});

// ── toHistoryMessages: empty-assistant guard (plan 2026-06-16 §3.1 方案 A) ──────
// A pure-action turn (tutor returned only an edit_file, no prose) stores an empty
// assistantMessage. Serialized verbatim it becomes { role: 'assistant', content: '' },
// which most LLM providers reject → the NEXT request 400s. toHistoryMessages() must
// substitute a placeholder so wire history never carries an empty assistant message.

describe('ConversationTurn.toHistoryMessages() — empty-assistant guard', () => {
    const PLACEHOLDER = '(no message — file edit applied)';

    it('substitutes a placeholder when assistantMessage is empty', () => {
        const turn = new ConversationTurn(1, 'just fix it', '', BASE_USAGE, new Date(TS));
        const msgs = turn.toHistoryMessages();
        expect(msgs[0]).toEqual({ role: 'user', content: 'just fix it' });
        expect(msgs[1].role).toBe('assistant');
        expect(msgs[1].content).toBe(PLACEHOLDER);
        expect(msgs[1].content).not.toBe('');
    });

    it('passes a non-empty assistantMessage through verbatim (no regression)', () => {
        const turn = new ConversationTurn(1, 'explain', 'here is a hint', BASE_USAGE, new Date(TS));
        expect(turn.toHistoryMessages()[1].content).toBe('here is a hint');
    });

    it('treats a whitespace-only assistantMessage as empty (.trim() boundary)', () => {
        const turn = new ConversationTurn(1, 'fix it', '   ', BASE_USAGE, new Date(TS));
        expect(turn.toHistoryMessages()[1].content).toBe(PLACEHOLDER);
    });

    it('keeps the real empty string in the persisted JSON (only the wire history is patched)', () => {
        const turn = new ConversationTurn(1, 'fix it', '', BASE_USAGE, new Date(TS));
        expect(turn.toJSON().assistantMessage).toBe('');
        expect(turn.toHistoryMessages()[1].content).toBe(PLACEHOLDER);
    });
});
