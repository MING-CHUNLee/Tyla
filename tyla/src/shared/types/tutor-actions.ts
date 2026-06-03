/**
 * Tutor action contract — the structured suggestions tutor_chats may return alongside prose.
 *
 * This is the single source of truth shared by:
 *   - the tutor gateway (wire → domain mapping), and
 *   - ExecuteTutorUseCase.dispatchActions() (execution behind the approval gate).
 *
 * Matches docs/api.md §7 and backend api_tutor_chats.md.
 */

/** A search-replace patch — never full file content (4000-token LLM output ceiling). */
export interface EditPatch {
    search: string;
    replace: string;
}

/** Structured suggestion returned by tutor_chats; executed by the TUI behind approval. */
export type TutorAction =
    | { type: 'edit_file';      path: string; patches: EditPatch[] }
    | { type: 'execute_script'; code: string }
    | { type: 'load_file';      path: string };

/**
 * Runtime guard for one wire action — drops anything malformed.
 *
 * Defensive on purpose: the server may emit actions a client version doesn't know,
 * mirroring the backend's leniency (Q-B2: a malformed `<actions>` block is stripped,
 * the prose is kept). An unknown or half-formed action is dropped, never crashes the turn.
 */
export function isTutorAction(value: unknown): value is TutorAction {
    if (typeof value !== 'object' || value === null) return false;
    const a = value as Record<string, unknown>;
    switch (a.type) {
        case 'edit_file':
            return typeof a.path === 'string' && Array.isArray(a.patches) &&
                a.patches.every(p =>
                    typeof p === 'object' && p !== null &&
                    typeof (p as EditPatch).search === 'string' &&
                    typeof (p as EditPatch).replace === 'string');
        case 'execute_script':
            return typeof a.code === 'string';
        case 'load_file':
            return typeof a.path === 'string';
        default:
            return false;
    }
}
