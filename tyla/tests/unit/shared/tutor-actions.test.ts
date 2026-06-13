/**
 * Unit Tests: isTutorAction runtime guard
 */

import { describe, it, expect } from 'vitest';
import { isTutorAction } from '../../../src/shared/types/tutor-actions';

describe('isTutorAction', () => {
    it('accepts a well-formed edit_file action with a start_line anchor', () => {
        expect(isTutorAction({
            type: 'edit_file',
            path: 'hw11.R',
            patches: [{ start_line: 9, search: 'a', replace: 'b' }],
        })).toBe(true);
    });

    it('accepts an edit_file patch without start_line (XML fallback / backward compat)', () => {
        expect(isTutorAction({
            type: 'edit_file',
            path: 'hw11.R',
            patches: [{ search: 'a', replace: 'b' }],
        })).toBe(true);
    });

    it('rejects an edit_file patch whose start_line is not a number', () => {
        expect(isTutorAction({
            type: 'edit_file',
            path: 'hw11.R',
            patches: [{ start_line: '9', search: 'a', replace: 'b' }],
        })).toBe(false);
    });

    it('accepts an edit_file with an empty patches array', () => {
        expect(isTutorAction({ type: 'edit_file', path: 'hw11.R', patches: [] })).toBe(true);
    });

    it('accepts a well-formed execute_script action', () => {
        expect(isTutorAction({ type: 'execute_script', code: 'print(1)' })).toBe(true);
    });

    it('accepts a well-formed load_file action', () => {
        expect(isTutorAction({ type: 'load_file', path: 'data.csv' })).toBe(true);
    });

    it('rejects an edit_file with a malformed patch (missing replace)', () => {
        expect(isTutorAction({
            type: 'edit_file',
            path: 'hw11.R',
            patches: [{ search: 'a' }],
        })).toBe(false);
    });

    it('rejects an edit_file whose patches is not an array', () => {
        expect(isTutorAction({ type: 'edit_file', path: 'hw11.R', patches: 'nope' })).toBe(false);
    });

    it('rejects edit_file with a non-string path', () => {
        expect(isTutorAction({ type: 'edit_file', path: 42, patches: [] })).toBe(false);
    });

    it('rejects execute_script with a non-string code', () => {
        expect(isTutorAction({ type: 'execute_script', code: 123 })).toBe(false);
    });

    it('rejects an unknown action type', () => {
        expect(isTutorAction({ type: 'delete_file', path: 'x' })).toBe(false);
    });

    it('rejects non-object / null values', () => {
        expect(isTutorAction(null)).toBe(false);
        expect(isTutorAction('edit_file')).toBe(false);
        expect(isTutorAction(undefined)).toBe(false);
    });
});
