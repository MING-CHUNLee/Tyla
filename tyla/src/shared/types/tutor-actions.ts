/**
 * Tutor action contract — the structured suggestions tutor_chats may return alongside prose.
 *
 * This is the single source of truth shared by:
 *   - the tutor gateway (wire → domain mapping), and
 *   - ExecuteTutorUseCase.dispatchActions() (execution behind the approval gate).
 *
 * Matches docs/api.md §7 and backend api_tutor_chats.md.
 */

/**
 * A search-replace patch — never full file content (4000-token LLM output ceiling).
 *
 * `start_line` (1-based, plan 2026-06-13 §2/§3) is the file line number of `search`'s
 * first line, read by the model from the `N| ` prefix the workspace context shows it.
 * `search`/`replace` are PLAIN content (no `N| ` prefixes). The backend marks it
 * required, but it stays optional here so an XML-fallback reply that omits it still
 * applies (degrades to a unique text match — see applyAnchoredPatches).
 */
export interface EditPatch {
    start_line?: number;
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
                a.patches.every(p => {
                    if (typeof p !== 'object' || p === null) return false;
                    const patch = p as EditPatch;
                    return typeof patch.search === 'string' &&
                        typeof patch.replace === 'string' &&
                        // start_line is required by the backend schema but optional on the
                        // wire (XML fallback); when present it must be a number.
                        (patch.start_line === undefined || typeof patch.start_line === 'number');
                });
        case 'execute_script':
            return typeof a.code === 'string';
        case 'load_file':
            return typeof a.path === 'string';
        default:
            return false;
    }
}
