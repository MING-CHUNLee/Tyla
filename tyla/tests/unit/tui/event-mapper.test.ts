/**
 * Unit Tests: TUI event-mapper — Option B approval wiring.
 *
 * Regression guard for the approval deadlock: a `script_proposed` event MUST produce a
 * `pendingApproval` of kind 'script' and drive the app into 'reviewing'; otherwise the
 * TUI never prompts the student and the turn hangs forever.
 */

import { describe, it, expect } from 'vitest';
import { mapAgentEventToMessage, AgentEvent } from '../../../src/tui/presentation/event-mapper';

describe('event-mapper — Option B approval cases', () => {
    it('script_proposed → pendingApproval kind "script" + reviewing (deadlock regression)', () => {
        const event = { type: 'script_proposed', data: { code: 'print(1)' } } as AgentEvent;

        const { sideEffect } = mapAgentEventToMessage(event);

        expect(sideEffect?.nextAppState).toBe('reviewing');
        expect(sideEffect?.pendingApproval).toEqual({ kind: 'script', script: { code: 'print(1)' } });
    });

    it('script_rejected → "Skipped script" status message', () => {
        const event = { type: 'script_rejected', data: {} } as AgentEvent;

        const { message } = mapAgentEventToMessage(event);

        expect(message?.type).toBe('status');
        expect(message?.content).toBe('Skipped script');
    });

    it('diff_proposed → pendingApproval kind "edit" + reviewing', () => {
        const event = {
            type: 'diff_proposed',
            data: { path: 'hw11.R', diff: 'd', original: 'o', proposed: 'p' },
        } as AgentEvent;

        const { sideEffect } = mapAgentEventToMessage(event);

        expect(sideEffect?.nextAppState).toBe('reviewing');
        expect(sideEffect?.pendingApproval).toEqual({
            kind: 'edit',
            edit: { path: 'hw11.R', diff: 'd', original: 'o', proposed: 'p' },
        });
    });

    it('install_proposed → pendingApproval kind "install" + reviewing', () => {
        const event = {
            type: 'install_proposed',
            data: { toInstall: ['dplyr'], alreadyInstalled: [], blocked: [], warnings: [] },
        } as AgentEvent;

        const { sideEffect } = mapAgentEventToMessage(event);

        expect(sideEffect?.nextAppState).toBe('reviewing');
        expect(sideEffect?.pendingApproval).toEqual({
            kind: 'install',
            install: { toInstall: ['dplyr'], alreadyInstalled: [], blocked: [], warnings: [] },
        });
    });

    it('status_update.info surfaces as a status message', () => {
        const event = {
            type: 'status_update',
            data: { info: 'No file named — auto-loading 2 source file(s): a.R, b.R' },
        } as AgentEvent;

        const { message } = mapAgentEventToMessage(event);

        expect(message?.type).toBe('status');
        expect(message?.content).toContain('auto-loading');
    });
});
