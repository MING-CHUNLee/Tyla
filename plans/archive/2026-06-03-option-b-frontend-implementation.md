# Option B — Frontend Type-Chain Implementation Draft

> **Status: TARGET / draft diffs (2026-06-03, rev. 2).** Concrete, copy-pasteable changes
> that turn the agentic-tutor pipeline from "single flat `content`" into the **Option B**
> shape: `guard_checks` (pre-call) → `tutor_chats` (with `guard_log_id` + `file_context`) →
> `actions[]` → approval gate. Companion to
> [`2026-06-03-agentic-tutor-react-pipeline.md`](2026-06-03-agentic-tutor-react-pipeline.md)
> (the decision doc) and the backend `Tyla-api/plans/2026-06-03-agentic-tutor-backend.md`.
>
> **Depends on backend WS-A + WS-B** (`guard_checks` status enum + `tutor_chats` `actions[]`
> / `guard_log_id`). Ship the frontend types behind the gateway path; nothing breaks until
> the backend returns the new fields. The `actions` array is simply absent until then.

> **Rev. 2 — resolves the pre-implementation review** ([`2026-06-03.md`](2026-06-03.md)).
> The first draft had two **blocking** gaps (the dispatch would deadlock and the gateway
> would break live tutor calls). Every item below is now addressed in-plan:
>
> | # | Review finding | Resolved in |
> |---|----------------|-------------|
> | 1 🔴 | `script_proposed` had no event-mapper case → approval **deadlock** | **§6.1** (new) — mapper cases + `pendingApproval` union |
> | 2 🔴 | `GuardCheckGateway` config-flag mechanism undefined → breaks live tutor calls pre-WS-A | **§3** + **§6.2** — `TYLA_GUARD_PRECALL` env flag |
> | 3 🟠 | `'error'` status unhandled in both gateways | **§3, §4a, §5b** — `'error'` branch (show + retry) |
> | 4 🟠 | post-§5e `guardCheckGateway!` unguarded → raw `TypeError` | **§5b/§5e** — early `if (!gateway) throw` friendly msg |
> | 5 🟡 | `EditStagingService._staged` grows unbounded under tutor use | **§5c** — new `stageOnly()` (no queue push) |
> | 6 🟡 | `status_update.info` silently dropped by mapper | **§6.1** — `info` case added |
> | 7 🟡 | §6 table said `file_loaded` but dispatch emits `text_output` | **§5c/§6.1** — aligned on `text_output` |
> | 8 🟢 | `TutorResult` carries no `actions` (doc mismatch) | **§5b** — explicit Phase-1 note + TODO |
> | 9 🟢 | diff header shows absolute path | **§5c** — stage relative, resolve at apply |
>
> Where the review offered a choice, the decision taken is called out inline as **Decided:**.

---

## 0. Scope

Four named changes plus the glue they imply:

1. **NEW `GuardCheckGateway`** — `infrastructure/api/guard/guard-check-gateway.ts`. HTTP
   client for `POST /api/v1/guard_checks`. Mirrors `TutorChatGateway` exactly (same headers,
   same profile/provider resolution). Returns a discriminated `GuardCheckResult`.
2. **`tutor-chat-gateway.ts`** — request gains `guard_log_id` (+ `file_context`); response/
   result gain `actions?`.
3. **`execute-tutor-use-case.ts`** — `callGateway()` becomes the Option B orchestration:
   guard pre-call → tutor send → **dispatch `actions` behind the approval gate**.
4. **TUI approval wiring** (`tui/presentation/event-mapper.ts` + `tui/controller/AppController.tsx`
   + `tui/presentation/types.ts`) — **the second blocking item**: `dispatchExecuteScript`
   emits `script_proposed` and then `await onApproval(...)`, but the mapper has no case for it,
   so the TUI never enters `reviewing`, the resolver is never called, and the turn **deadlocks**.
   §6.1 adds `script_proposed` / `script_rejected` mapper cases and consolidates the two
   parallel `pendingReview` / `pendingInstall` slots into one `pendingApproval` union.

Supporting:
- **NEW shared type** `TutorAction` — `shared/types/tutor-actions.ts` (single source the
  gateway result and the dispatch both import).
- **Reuse, don't reinvent** the approval gate: `EditStagingService.stage()/applyEdit()` +
  the `onApproval` callback, exactly as
  [`execute-instruction-use-case.ts:210`](../tyla/src/application/use-cases/execute-instruction-use-case.ts#L210)
  does today. The tutor stages with a **new `stageOnly()`** (§5c) so its per-action
  stage→apply pattern never pollutes the instruction pipeline's drain queue.

---

## 1. The type chain at a glance

```
buildFileContext()  ──► file_context: string ─┐
                                              │
GuardCheckGateway.check(prompt)               │
   └─► GuardCheckResult                        │
        ├ forbidden → show refusal, end turn   │
        ├ error     → show error + retry, end  │
        └ done/unavailable → guardLogId ───────┤
                                              ▼
TutorChatGateway.send(prompt, history, guardLogId, fileContext)
   └─► TutorChatResult { status, content, actions?, usage }
                                              │
                                              ▼
ExecuteTutorUseCase.dispatchActions(actions)
   ├ edit_file      → applyPatches → stageOnly → diff_proposed → onApproval → applyEdit
   ├ execute_script → script_proposed → onApproval → r_exec (read-only) | script_rejected
   └ load_file      → file_read → text_output
```

---

## 2. NEW shared type — `shared/types/tutor-actions.ts`

The one place the action contract lives; imported by the gateway (wire→domain mapping) and
the use case (dispatch). Matches `docs/api.md` §7 and backend `api_tutor_chats.md`.

```ts
// tyla/src/shared/types/tutor-actions.ts

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

/** Runtime guard for one wire action — drops anything malformed (defensive: server may
 *  emit actions the client version doesn't know). */
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
```

> **Why a runtime guard, not just a TS type?** Q-B2: the backend strips a malformed
> `<actions>` block and keeps the prose. The client mirrors that leniency — an unknown or
> half-formed action is dropped, never crashes the turn.

---

## 3. NEW file — `infrastructure/api/guard/guard-check-gateway.ts`

Near-verbatim mirror of `TutorChatGateway`; only the path, the response shape, and the
result union differ. New full file (no diff — it doesn't exist yet):

```ts
// tyla/src/infrastructure/api/guard/guard-check-gateway.ts
import axios from 'axios';
import { getEnv, detectProvider, getApiKeyForProvider, getEndpointForProvider, ENV_VARS } from '../../config';
import { getProfile } from '../../config/profile';
import { TYLA_API } from '../../config/constants';

// ── Wire types ────────────────────────────────────────────────────────────────

// Unified ApiStatus enum (decision doc §3.1) — shared by guard_checks and tutor_chats.
interface GuardCheckResponse {
    log_id: number;
    status: 'done' | 'forbidden' | 'error' | 'unavailable';
    refusal: string | null;
    usage: { input_tokens: number; output_tokens: number } | null;
}

// ── Domain result ─────────────────────────────────────────────────────────────

export type GuardCheckResult =
    | { status: 'done' | 'unavailable'; logId: number; guardSkipped: boolean; usage: GuardUsage }
    | { status: 'forbidden';            logId: number; refusal: string;        usage: GuardUsage }
    | { status: 'error';                message: string;                       usage: GuardUsage };

type GuardUsage = { inputTokens: number; outputTokens: number };

// Returns validated non-negative integers; falls back to 0 on invalid. (Same rule as the
// tutor gateway — keep one copy if you prefer: extract to shared/api/parse-usage.ts.)
function parseUsage(raw: { input_tokens: number; output_tokens: number } | null | undefined): GuardUsage {
    const MAX = 1_000_000;
    const safe = (n: unknown): number =>
        typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX ? n : 0;
    return { inputTokens: safe(raw?.input_tokens), outputTokens: safe(raw?.output_tokens) };
}

// ── Gateway ───────────────────────────────────────────────────────────────────

export class GuardCheckGateway {
    private readonly baseUrl: string;
    private readonly timeout: number;

    constructor(
        private readonly onWarning?: (message: string) => void,
        private readonly directory?: string,
    ) {
        this.baseUrl = `http://${TYLA_API.HOST}:${TYLA_API.PORT}`;
        this.timeout = TYLA_API.DEFAULT_TIMEOUT_MS;
    }

    /** Run the safety pre-call on the student's prompt only (no file_context — saves judge tokens). */
    async check(prompt: string): Promise<GuardCheckResult> {
        const profile  = getProfile(this.directory);
        const provider = detectProvider();

        if (!profile) {
            throw new Error('guard-api: profile.json missing');
        }

        let apiKey: string;
        try {
            apiKey = getApiKeyForProvider(provider);
        } catch {
            throw new Error('guard-api: could not resolve LLM key');
        }

        const response = await axios.post<GuardCheckResponse>(
            `${this.baseUrl}/api/v1/guard_checks`,
            {
                course_id:  profile.courseId,
                project_id: profile.projectId,
                student_id: profile.studentId,
                prompt,
            },
            {
                timeout: this.timeout,
                headers: {
                    'Content-Type':   'application/json',
                    'X-LLM-Key':      apiKey,
                    'X-LLM-Provider': provider,
                    'X-LLM-Endpoint': getEndpointForProvider(provider),
                    'X-LLM-Model':    getEnv(ENV_VARS.LLM_MODEL) ?? '',
                },
                // WS-A: status lives in the body, HTTP is always 200 (only malformed
                // request / missing key → 4xx). Keep 202 accepted for the pre-WS-A bridge.
                validateStatus: (status) => status === 200 || status === 202,
            },
        );

        const data = response.data;

        if (data.status === 'forbidden') {
            return { status: 'forbidden', logId: data.log_id, refusal: data.refusal ?? '', usage: parseUsage(data.usage) };
        }

        // decision doc §3.1: backend/judge error → surface to student, suggest retry.
        // No valid log_id is produced, so the turn must NOT proceed to tutor_chats.
        if (data.status === 'error') {
            return { status: 'error', message: data.refusal ?? 'guard check failed', usage: parseUsage(data.usage) };
        }

        const guardSkipped = data.status === 'unavailable';
        if (guardSkipped) {
            this.onWarning?.('guard skipped: llm unavailable');
        }

        return { status: data.status, logId: data.log_id, guardSkipped, usage: parseUsage(data.usage) };
    }
}
```

> **Live-vs-target note — the config flag (review §2, blocking).** Until backend WS-A ships,
> `/guard_checks` returns `{ allowed, attack_probability, evaluation }` (no `status`, no
> `log_id`) and maps a missing key to `401`. If the gateway were wired the moment a
> `profile.json` exists (as the first draft's §6 did), **every profiled tutor call would
> break the day this lands**: `data.status` is `undefined` → falls through to the success
> branch → `guard.logId` is `undefined` → `tutor_chats` is called with
> `guard_log_id: undefined` → backend rejects.
>
> **Decided: gate on an explicit env flag, not on profile presence.** Add to the `ENV_VARS`
> map in [`config/index.ts`](../tyla/src/infrastructure/config/index.ts#L54) (where
> `LLM_MODEL` etc. already live):
>
> ```ts
> GUARD_PRECALL: 'TYLA_GUARD_PRECALL',   // '1' / 'true' → enable Option B guard pre-call
> ```
>
> The factory (§6.2) constructs `GuardCheckGateway` **only when the flag is truthy AND a
> profile exists**. Default-off means: merging §2–§5 changes nothing for existing users
> (the use case still needs `guardCheckGateway` to run the Option B path — see §5b's early
> check). When WS-A is green, flip `TYLA_GUARD_PRECALL=1` in the deployed `.env`; no code
> change, instantly revertable if the backend regresses.

---

## 4. Diff — `tutor-chat-gateway.ts`

Three edits: request body, response/result types, `send()` signature.

### 4a. Result + wire types (gain `actions`)

```diff
+import { TutorAction, isTutorAction } from '../../../shared/types/tutor-actions';
 import { SessionMessage } from '../../../shared/types/messages';

 interface TutorChatResponse {
     log_id: number;
-    status: 'done' | 'forbidden' | 'unavailable';
+    status: 'done' | 'forbidden' | 'error' | 'unavailable';   // unified ApiStatus
     content: string;
+    actions?: unknown[];          // validated → TutorAction[] in send()
     usage: { input_tokens: number; output_tokens: number } | null;
 }

 export type TutorChatResult =
-    | { status: 'done' | 'unavailable'; logId: number; content: string; usage: { inputTokens: number; outputTokens: number }; guardSkipped: boolean }
-    | { status: 'forbidden';            logId: number; content: string; usage: { inputTokens: number; outputTokens: number } };
+    | { status: 'done' | 'unavailable'; logId: number; content: string; actions: TutorAction[]; usage: { inputTokens: number; outputTokens: number }; guardSkipped: boolean }
+    | { status: 'forbidden';            logId: number; content: string; usage: { inputTokens: number; outputTokens: number } }
+    | { status: 'error';                logId: number; content: string; usage: { inputTokens: number; outputTokens: number } };
```

> `'error'` (review §3) carries **no actions** — same as `forbidden`. `send()` returns it
> verbatim; §5b shows it to the student with a retry hint.

### 4b. `send()` — take `guardLogId` (+ `fileContext`), forward them, map `actions`

```diff
-    async send(prompt: string, history: SessionMessage[]): Promise<TutorChatResult> {
+    async send(
+        prompt: string,
+        history: SessionMessage[],
+        guardLogId: number,
+        fileContext?: string,
+    ): Promise<TutorChatResult> {
         const profile  = getProfile(this.directory);
         const provider = detectProvider();
         ...
         const response = await axios.post<TutorChatResponse>(
             `${this.baseUrl}/api/v1/tutor_chats`,
             {
                 course_id:  profile.courseId,
                 project_id: profile.projectId,
                 student_id: profile.studentId,
+                guard_log_id: guardLogId,
                 prompt,
                 history,
+                ...(fileContext ? { file_context: fileContext } : {}),
             },
             ...
         );

         const data = response.data;

         if (data.status === 'forbidden') {
             return { status: 'forbidden', logId: data.log_id, content: data.content, usage: parseUsage(data.usage) };
         }
+        if (data.status === 'error') {
+            return { status: 'error', logId: data.log_id, content: data.content, usage: parseUsage(data.usage) };
+        }

         const guardSkipped = data.status === 'unavailable';
         if (guardSkipped) this.onWarning?.('guard skipped: llm unavailable');

+        // Q-B2: keep only well-formed actions; drop the rest, never throw.
+        const actions: TutorAction[] = Array.isArray(data.actions)
+            ? data.actions.filter(isTutorAction)
+            : [];

         return {
             status:      data.status,
             logId:       data.log_id,
             content:     data.content,
+            actions,
             guardSkipped,
             usage: parseUsage(data.usage),
         };
     }
```

> `forbidden` here means the **guard credential was missing/invalid/mismatched** (the
> backend rejected the `guard_log_id`), not a fresh content judgement — see the decision doc
> §3.3. No `actions` on `forbidden`/`error`.
>
> `file_context` is threaded through from the
> [gateway-file-context plan](2026-06-02-gateway-file-context.md); this task only adds the
> pass-through param. Building the string is §5's `buildFileContext()`.

---

## 5. Diff — `execute-tutor-use-case.ts`

### 5a. Deps — add the guard gateway + the approval gate

```diff
 import { TutorChatGateway } from '../../infrastructure/api/tutor/tutor-chat-gateway';
+import { GuardCheckGateway } from '../../infrastructure/api/guard/guard-check-gateway';
+import { EditStagingService } from '../services/edit-staging-service';
+import { DiffEngine } from '../services/diff-engine';
+import { IFileSystem } from '../../domain/types/file-system';
+import { LocalFileSystem } from '../../infrastructure/filesystem/local-file-system';
+import { TutorAction, EditPatch } from '../../shared/types/tutor-actions';

 export interface ExecuteTutorDeps {
     llm: LLMGateway;
     registry: ToolRegistry;
     directory: string;
     emit: EmitFn;
     policyLoader?: PolicyLoader;
     guardAgent?: IGuardAgent;
     tutorChatGateway?: TutorChatGateway;
+    /** Option B pre-call. When present (with tutorChatGateway), runs the guard→tutor→actions pipeline. */
+    guardCheckGateway?: GuardCheckGateway;
+    /** Human-in-the-loop gate for edit_file / execute_script. Same contract as the edit pipeline. */
+    onApproval?: (edit: { path: string; diff: string; original: string; proposed: string }) => Promise<boolean>;
+    /** Defaults built from fileSystem + diffEngine below. */
+    stagingService?: EditStagingService;
+    diffEngine?: DiffEngine;
+    fileSystem?: IFileSystem;
 }
```

Construct the staging service once (mirrors the instruction use case):

```diff
 export class ExecuteTutorUseCase {
     private readonly policyLoader: PolicyLoader;
+    private readonly fileSystem: IFileSystem;
+    private readonly stagingService: EditStagingService;

     constructor(private readonly deps: ExecuteTutorDeps, private readonly style: WorkflowMode) {
         this.policyLoader = deps.policyLoader ?? new PolicyLoader();
+        this.fileSystem = deps.fileSystem ?? new LocalFileSystem();
+        this.stagingService = deps.stagingService ??
+            new EditStagingService(this.fileSystem, deps.diffEngine ?? new DiffEngine());
     }
```

### 5b. `callGateway()` → Option B orchestration

Replace the body of `callGateway()` (current
[`:82`](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L82)) with: guard
pre-call → tutor send (with `guardLogId` + `fileContext`) → dispatch actions.

```ts
private async callGateway(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
    // ── 0. Guard the gateways (review §4) ──────────────────────────────────────
    // After §5e removes the offline path, execute() calls straight here. Without
    // these checks, an undefined gateway throws a raw `TypeError: ... reading 'check'`.
    // Surface a clear, actionable message instead.
    if (!this.deps.guardCheckGateway || !this.deps.tutorChatGateway) {
        const msg = 'Tutor backend not configured — set a valid profile.json and '
            + 'TYLA_GUARD_PRECALL=1, then restart tyla.';
        this.deps.emit('error', { message: msg, phase: 'guard' });
        throw new Error(msg);
    }

    // ── 1. file_context (reuses scan + read helpers) ───────────────────────────
    const fileContext = await this.buildFileContext(instruction);

    // ── 2. Guard pre-call ──────────────────────────────────────────────────────
    this.deps.emit('phase_start', { phase: 'guard', description: 'Running safety check' });
    let guard;
    try {
        guard = await this.deps.guardCheckGateway.check(instruction);
    } catch (error) {
        return this.failTutor('guard', error);
    }
    this.deps.emit('phase_end', { phase: 'guard', success: true });

    if (guard.status === 'forbidden') {
        this.deps.emit('guard_blocked', { reason: 'content_policy', phase: 'guard' });
        this.deps.emit('text_output', { content: guard.refusal });
        return { content: guard.refusal, usage: toTurnUsage(guard.usage) };
    }
    if (guard.status === 'error') {
        // review §3 / decision doc §3.1: no log_id produced → cannot proceed. Show + retry.
        this.deps.emit('error', { message: `Safety check failed: ${guard.message}. Please try again.`, phase: 'guard' });
        return { content: '', usage: toTurnUsage(guard.usage) };
    }
    if (guard.guardSkipped) {
        this.deps.emit('status_update', { warning: 'guard skipped: llm unavailable' });
    }

    // ── 3. Tutor call ──────────────────────────────────────────────────────────
    this.deps.emit('phase_start', { phase: 'tutor', description: 'Calling tutor API' });
    let result;
    try {
        result = await this.deps.tutorChatGateway.send(instruction, history, guard.logId, fileContext);
    } catch (error) {
        return this.failTutor('tutor', error);
    }

    if (result.status === 'forbidden') {
        // guard_log_id rejected by the backend (missing/invalid/mismatch)
        this.deps.emit('guard_blocked', { reason: 'guard_credential', phase: 'tutor' });
        this.deps.emit('text_output', { content: result.content });
        this.deps.emit('phase_end', { phase: 'tutor', success: true });
        return { content: result.content, usage: addUsage(toTurnUsage(guard.usage), toTurnUsage(result.usage)) };
    }
    if (result.status === 'error') {
        // review §3: server/judge error on the tutor leg — show + retry, no actions.
        this.deps.emit('phase_end', { phase: 'tutor', success: false });
        this.deps.emit('error', { message: `Tutor call failed: ${result.content || 'unknown error'}. Please try again.`, phase: 'tutor' });
        return { content: result.content, usage: addUsage(toTurnUsage(guard.usage), toTurnUsage(result.usage)) };
    }
    if (result.guardSkipped) {
        this.deps.emit('status_update', { warning: 'tutor: guard credential accepted under fail-open' });
    }

    this.deps.emit('text_output', { content: result.content });
    this.deps.emit('phase_end', { phase: 'tutor', success: true });

    // ── 4. Dispatch actions behind the approval gate ───────────────────────────
    await this.dispatchActions(result.actions);

    // guard + tutor usages are disjoint (tutor no longer re-runs guard) — summing is safe.
    // NOTE (review §8): `actions` are dispatched here and intentionally NOT returned on
    // TutorResult — Phase 1 does not persist "which actions were proposed" in session
    // history. TODO(Phase 2 / Option A): thread `actions` onto TutorResult if session
    // replay needs them.
    return { content: result.content, usage: addUsage(toTurnUsage(guard.usage), toTurnUsage(result.usage)) };
}

private failTutor(phase: 'guard' | 'tutor', error: unknown): never {
    this.deps.emit('phase_end', { phase, success: false });
    this.deps.emit('error', { message: error instanceof Error ? error.message : String(error), phase });
    throw error;
}
```

Two tiny usage helpers (top of file, or `shared/`):

```ts
function toTurnUsage(u: { inputTokens: number; outputTokens: number }): TurnUsage {
    return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 };
}
function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheCreationTokens: 0, cacheReadTokens: 0,
    };
}
```

### 5c. `dispatchActions()` — the approval gate (NEW)

Reuses `EditStagingService` + `onApproval` so **`applyEdit()` stays the single
`fs.write` site**.

```ts
private async dispatchActions(actions: TutorAction[]): Promise<void> {
    if (actions.length === 0) return;
    this.deps.emit('phase_start', { phase: 'actions', description: `Dispatching ${actions.length} action(s)` });

    for (const action of actions) {
        switch (action.type) {
            case 'edit_file':      await this.dispatchEditFile(action); break;
            case 'execute_script': await this.dispatchExecuteScript(action); break;
            case 'load_file':      await this.dispatchLoadFile(action); break;
        }
    }

    this.deps.emit('phase_end', { phase: 'actions', success: true });
}

private async dispatchEditFile(action: { path: string; patches: EditPatch[] }): Promise<void> {
    const absPath = path.resolve(this.deps.directory, action.path);

    let original = '';
    try {
        original = this.fileSystem.read(absPath);
    } catch {
        original = ''; // new file
    }

    const proposed = applyPatches(original, action.patches,
        (msg) => this.deps.emit('status_update', { warning: `edit_file ${action.path}: ${msg}` }));

    // review §5 + §9: stageOnly() does NOT push to the drain queue (the tutor applies
    // per-action, never drains), and stores the *relative* path for display while
    // resolving against `directory` for read/apply — so the diff header shows
    // `hw11.R`, not `C:\Users\Student\hw11\hw11.R`.
    const staged = this.stagingService.stageOnly(action.path, proposed, this.deps.directory);
    if ('error' in staged) {
        if (staged.isHardError) this.deps.emit('error', { message: staged.error, phase: 'actions' });
        else this.deps.emit('status_update', { warning: staged.error });
        return;
    }

    this.deps.emit('diff_proposed', {
        path: staged.staged.path, diff: staged.staged.diff,        // relative
        original: staged.staged.original, proposed: staged.staged.content,
    });

    const approved = this.deps.onApproval
        ? await this.deps.onApproval({
            path: staged.staged.path, diff: staged.staged.diff,
            original: staged.staged.original, proposed: staged.staged.content,
          })
        : false;

    if (approved) {
        this.stagingService.applyEdit(staged.staged);             // uses staged.absPath
        this.deps.emit('edit_applied', { path: action.path });
    } else {
        this.deps.emit('edit_rejected', { path: action.path });
    }
}

private async dispatchExecuteScript(action: { code: string }): Promise<void> {
    this.deps.emit('script_proposed', { code: action.code });
    const approved = this.deps.onApproval
        ? await this.deps.onApproval({ path: '(r script)', diff: action.code, original: '', proposed: action.code })
        : false;
    if (!approved) { this.deps.emit('script_rejected', {}); return; }

    const rExec = this.deps.registry.get('r_exec'); // read-only guard lives in the tool
    if (!rExec) { this.deps.emit('status_update', { warning: 'r_exec tool not registered' }); return; }
    const res = await rExec.execute({ code: action.code });
    this.deps.emit('tool_result_r_exec', { data: res.data ?? { stdout: res.content } });
}

private async dispatchLoadFile(action: { path: string }): Promise<void> {
    const readTool = this.deps.registry.get(action.path.toLowerCase().endsWith('.pdf') ? 'pdf_read' : 'file_read');
    if (!readTool) return;
    const res = await readTool.execute({ path: action.path });
    if (!res.isError) this.deps.emit('text_output', { content: res.content });
}
```

`applyPatches` — pure helper (first-occurrence search-replace, skip-and-warn on miss):

```ts
function applyPatches(original: string, patches: EditPatch[], warn: (m: string) => void): string {
    let out = original;
    for (const { search, replace } of patches) {
        if (!out.includes(search)) { warn(`patch search text not found, skipped`); continue; }
        out = out.replace(search, replace); // first occurrence only
    }
    return out;
}
```

#### `EditStagingService.stageOnly()` — NEW (review §5 + §9)

The existing `stage()` always `_staged.push(...)`; it's designed for the **batch** pattern
(`FileEditTool` accumulates → use case `drainStagedEdits()` once). The tutor uses a
**per-action** pattern (`stage → applyEdit` immediately, no drain), so calling `stage()`
would grow `_staged` for the whole session and never clear it. Add a sibling that skips the
queue and carries an absolute path for apply while keeping the relative path for display:

```diff
 export interface StagedEdit {
     path: string;      // relative path as given by the LLM (shown in the diff header)
     content: string;
     original: string;
     diff: string;
+    absPath?: string;  // set by stageOnly(): resolved target for applyEdit (tutor uses a base dir ≠ cwd)
 }

+    /**
+     * Like stage(), but (a) does NOT push to the drain queue — for callers that apply
+     * per-edit (the tutor dispatch), and (b) resolves `relPath` against `baseDir` (not cwd)
+     * for read/diff/apply while keeping `relPath` for display.
+     */
+    stageOnly(relPath: string, content: string, baseDir: string):
+        { staged: StagedEdit } | { error: string; isHardError: boolean } {
+        const absPath = path.resolve(baseDir, relPath);
+        const exists  = this.fileSystem.exists(absPath);
+
+        let original = '';
+        if (exists) {
+            try {
+                original = this.fileSystem.read(absPath);
+            } catch (err) {
+                const msg = err instanceof Error ? err.message : String(err);
+                return { error: `Cannot read ${path.basename(absPath)}: ${msg}`, isHardError: true };
+            }
+        }
+        if (original === content) {
+            return { error: `No changes detected in ${path.basename(absPath)}.`, isHardError: false };
+        }
+
+        const diff = this.diffEngine.generateColoredDiff(original, content);
+        return { staged: { path: relPath, content, original, diff, absPath } };   // not pushed
+    }
```

`applyEdit()` prefers the carried absolute path so it writes to the tutor's `directory`,
not `cwd`:

```diff
     applyEdit(edit: StagedEdit): void {
-        const absPath = path.resolve(edit.path);
+        const absPath = edit.absPath ?? path.resolve(edit.path);
         this.fileSystem.mkdir(path.dirname(absPath));
         this.fileSystem.write(absPath, edit.content);
     }
```

### 5d. Where the student's context file comes from

**The acquisition code already exists** — it's the two private helpers the offline path uses
today. Option B just feeds their output to the gateway instead of into a local system
prompt. The full chain, citing what's already on disk:

**(i) `buildProjectContext()`** — [execute-tutor-use-case.ts:126](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L126).
Runs the **`file_scan`** tool over `this.deps.directory` and returns:
- `projectContext: string` — the scan summary (project name + file listing), and
- `scannedFiles: Array<{ name; path }>` — flattened from `scanResult.data.files` (the
  `rScripts / rMarkdown / rData / dataFiles / documents` groups).

```ts
const scanTool = this.deps.registry.get('file_scan');
const scanResult = await scanTool.execute({ directory: this.deps.directory });
projectContext = scanResult.content;          // the listing text
// scanResult.data.files → flatten every group into { name, path }[]
```

**(ii) `readRelevantFiles(instruction, scannedFiles)`** — [execute-tutor-use-case.ts:158](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L158).
This is the **actual file-content fetch**. It selects the scanned files whose **name or
extension is mentioned in the student's prompt**, then reads each through the
**`file_read`** (or **`pdf_read`** for `.pdf`) tool and concatenates the contents:

```ts
const readTargets = scannedFiles.filter(file => {
    const nameLower = file.name.toLowerCase();
    if (instructionLower.includes(nameLower)) return true;       // "...my hw11.R..." → match
    const ext = path.extname(nameLower).slice(1);
    return ext.length > 0 && instructionLower.includes(ext);     // "...the .R file..." → match
});
for (const file of readTargets) {
    const tool = this.deps.registry.get(file.name.endsWith('.pdf') ? 'pdf_read' : 'file_read');
    const result = await tool.execute({ path: file.path });      // ← reads the student's code
    if (!result.isError) fileContents += result.content + '\n\n';
}
```

**(iii) `buildFileContext()`** — the **only new code** here. It composes (i) + (ii) into the
single token-budgeted plain-text blob `tutor_chats` receives as `file_context`. This is
Step 1 + Step 4 of the [gateway-file-context plan](2026-06-02-gateway-file-context.md),
made concrete:

```ts
private async buildFileContext(instruction: string): Promise<string> {
    this.deps.emit('phase_start', { phase: 'scan', description: 'Building file context' });
    const { projectContext, scannedFiles } = await this.buildProjectContext();   // (i)  file_scan

    // (ii) explicit match first; (iv) fall back to the top-N source files if nothing named.
    let fileContents = await this.readRelevantFiles(instruction, scannedFiles);
    if (!fileContents) {
        fileContents = await this.readFallbackFiles(scannedFiles);
    }
    this.deps.emit('phase_end', { phase: 'scan', success: true });

    const parts: string[] = [];
    if (projectContext) parts.push(`## Project Context\n${projectContext}`);
    if (fileContents)   parts.push(`## File Contents\n${fileContents}`);

    // Same MAX_CONTEXT_TOKENS = 6_000 cap the offline assemblePrompt() applies — enforced
    // here so the frontend controls exactly what crosses the wire.
    return this.truncateToTokenBudget(parts.join('\n\n'), MAX_CONTEXT_TOKENS);
}

private truncateToTokenBudget(text: string, budget: number): string {
    if (estimateTokens(text) <= budget) return text;
    return text.slice(0, budget * 4) + '\n[…truncated]';   // ~4 chars/token
}
```

`callGateway()` (§5b step 1) calls `buildFileContext(instruction)` and passes the result to
`tutorChatGateway.send(instruction, history, guard.logId, fileContext)`. The backend injects
it verbatim under `## File Context` before the tutor LLM call — it never touches the
student's filesystem.

**(iv) `readFallbackFiles()`** — the no-filename safety net (**NEW**). When (ii) matches
nothing — *"why does my code fail?"* with no filename — read the **top-N source files**
(rScripts first), so the tutor sees code instead of just a listing. Three pieces:

**Tag scanned files with their group** so the fallback can prefer source over data. Small
change to `buildProjectContext()`'s flatten (it currently drops the group key):

```diff
-                        for (const group of Object.values(data.files)) {
-                            if (Array.isArray(group)) {
-                                scannedFiles.push(...group.map(file => ({ name: file.name, path: file.path })));
-                            }
-                        }
+                        for (const [group, files] of Object.entries(data.files)) {
+                            if (Array.isArray(files)) {
+                                scannedFiles.push(...files.map(file => ({ name: file.name, path: file.path, group })));
+                            }
+                        }
```

```diff
-        scannedFiles: Array<{ name: string; path: string }>;
+        scannedFiles: ScannedFile[];
```

```ts
// near the top of the file
type ScannedFile = { name: string; path: string; group: string };
const FALLBACK_FILE_LIMIT = 5;                     // read at most N when nothing is named
// Code/source groups only. Data (rData / dataFiles / rProject) AND documents (PDFs etc.)
// are never auto-read — documents are large and the assignment policy may already carry
// their content, so they load name-only (only when the student references them).
// Order = preference. THIS is the one-line seam for new languages: add 'pythonScripts'
// once file_scan surfaces it — see §9.
const FALLBACK_GROUPS = ['rScripts', 'rMarkdown'] as const;
```

**Extract the per-file read loop** out of `readRelevantFiles()` so both callers share it (no
duplication, identical error handling):

```ts
/** Read a fixed set of files through file_read / pdf_read, concatenating their contents. */
private async readFiles(targets: Array<{ name: string; path: string }>): Promise<string> {
    let out = '';
    for (const file of targets) {
        try {
            const tool = this.deps.registry.get(file.name.toLowerCase().endsWith('.pdf') ? 'pdf_read' : 'file_read');
            if (!tool) continue;
            const result = await tool.execute({ path: file.path });
            if (!result.isError) out += `### ${file.name}\n${result.content}\n\n`;
        } catch (error) {
            this.deps.emit('status_update', {
                warning: `Could not read file ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    return out;
}
```

`readRelevantFiles()` then becomes just the **match filter** + `readFiles()`; and the new
fallback ranks by group, caps at N, and **stops once it hits the token budget** so a few
large scripts can't blow `MAX_CONTEXT_TOKENS`:

```ts
private async readFallbackFiles(scannedFiles: ScannedFile[]): Promise<string> {
    const ranked = scannedFiles
        .filter(f => (FALLBACK_GROUPS as readonly string[]).includes(f.group))
        .sort((a, b) => FALLBACK_GROUPS.indexOf(a.group as never) - FALLBACK_GROUPS.indexOf(b.group as never));

    const targets = ranked.slice(0, FALLBACK_FILE_LIMIT);
    if (targets.length === 0) return '';
    this.deps.emit('status_update', {
        info: `No file named — auto-loading ${targets.length} source file(s): ${targets.map(t => t.name).join(', ')}`,
    });

    // Read one at a time, stop early once we'd exceed the context budget (avoid wasted reads).
    let out = '';
    for (const file of targets) {
        const chunk = await this.readFiles([file]);
        if (estimateTokens(out + chunk) > MAX_CONTEXT_TOKENS) break;
        out += chunk;
    }
    return out;
}
```

> **Behaviour:** named file → contents for exactly that file (unchanged — this is also how a
> PDF / document gets loaded: **by name only**). No name → up to 5 `rScripts` / `rMarkdown`
> (in that order), capped at the 6 000-token budget, with a one-line `status_update` telling
> the student which files were auto-loaded (so the auto-load is transparent, not silent).
> Data files, `.RData`, and documents/PDFs are never auto-read.

### 5e. Offline fallback removal

The decision doc §1 records **offline fallback removed** (the TUI can't run without the
backend). So `execute()` collapses to the gateway path:

```diff
 async execute(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
-    if (this.deps.tutorChatGateway) {
-        return this.callGateway(instruction, history);
-    }
-    // ── Local fallback (offline / no backend) ──────────────────────────────
-    ...buildProjectContext / readRelevantFiles / runGuard / assemblePrompt / callLLMStream...
+    return this.callGateway(instruction, history);
 }
```

- **Keep** `buildProjectContext()` + `readRelevantFiles()` — now feed `buildFileContext()`.
- **Keep** `assemblePrompt()`'s budgeting only if you extract the section-assembly helper
  §5d points to; otherwise inline it.
- **Delete** `runGuard()` (replaced by `GuardCheckGateway`), `callLLMStream()` +
  `compactHistory()` (the server composes the prompt and calls the LLM now). The local
  `guardAgent?` / `llm` deps and the `MAX_*_TOKENS` client budget go with them.

> **Review §4 — don't ship 5e without 5b's guard.** Once the `if (this.deps.tutorChatGateway)`
> branch is gone, `execute()` calls `callGateway()` unconditionally. If the gateways are
> `undefined` (no profile, or `TYLA_GUARD_PRECALL` off), the old code would dereference
> `guardCheckGateway!.check()` and throw a bare `TypeError` that the student sees. The early
> `if (!guardCheckGateway || !tutorChatGateway) { emit error; throw }` added at the top of
> `callGateway()` in **§5b** is the guard that makes this safe — land it *with* or *before* 5e.

> Do 5e as a **second commit** after 5a–5d land green — it's the largest deletion and the
> easiest to review in isolation.

---

## 6. Wiring

Two seams: the **TUI approval path** (§6.1 — the second blocking item) and the
**composition root** (§6.2).

### 6.1 TUI approval gate — `event-mapper.ts` + `AppController.tsx` + `types.ts` (review §1, §6, §7)

**The deadlock (review §1, blocking).** `dispatchExecuteScript` (§5c) does:
`emit('script_proposed', …)` then `await onApproval(…)`. In the TUI, `onApproval` returns a
Promise that only resolves when `handleReviewDecision` fires
([AppController.tsx:100](../tyla/src/tui/controller/AppController.tsx#L100)) — and that only
runs once `appState === 'reviewing'` shows the student a y/n prompt. `reviewing` is entered by
the mapper's side-effects. But [`event-mapper.ts`](../tyla/src/tui/presentation/event-mapper.ts)
has **no `script_proposed` case** → it hits `default: return {}` → no side-effect → TUI stays
`processing` → the student is never prompted → the resolver never fires → **the turn hangs
forever**. Same latent gap for `script_rejected` (no feedback when the student declines).

**Decided (review closing note): take Option C — one `pendingApproval` union.** The first
draft has two parallel slots (`pendingReview` / `pendingInstall`) that are already mutually
exclusive in practice. Since `script_proposed` would need a third slot, collapse all three
into a single discriminated union now — it's the lowest-marginal-cost moment (we're already
touching `types.ts` / `AppController.tsx` / `event-mapper.ts`), and a future `load_file`
approval inherits it for free.

**`types.ts`** — replace the two nullable slots with one union:

```diff
+export type PendingApproval =
+    | { kind: 'edit';    edit: PendingEdit }
+    | { kind: 'install'; install: PendingInstall }
+    | { kind: 'script'; script: { code: string } };   // ← unblocks execute_script
```

> Minimal alternative (if Option C is deferred): keep `pendingReview` and just map
> `script_proposed` onto it (`path: '(r script)'`, `diff: code`) so `DiffReview` renders the
> script verbatim. That clears the **blocking** deadlock with the fewest lines; the union is
> the cleaner end state. Either way **the `script_rejected` case below is mandatory.**

**`event-mapper.ts`** — add the three missing cases (`script_proposed`, `script_rejected`,
and the dropped `info` field from review §6). Shown against the Option-C union:

```diff
+        case 'script_proposed':
+            return {
+                sideEffect: {
+                    pendingApproval: { kind: 'script', script: { code: event.data.code as string } },
+                    nextAppState: 'reviewing',
+                },
+            };
+
+        case 'script_rejected':
+            return { message: makeMessage('status', 'Skipped script') };
+
         case 'status_update': {
             const parts: string[] = [];
             if (event.data.warning)   parts.push(`⚠ ${event.data.warning}`);
+            if (event.data.info)      parts.push(event.data.info as string);   // review §6: readFallbackFiles auto-load notice
             if (event.data.plugins)   parts.push(`Plugins: ${event.data.plugins.join(', ')}`);
             if (event.data.knowledge) parts.push(`Knowledge: ${event.data.knowledge.join(', ')}`);
             if (parts.length === 0)   return {};
             return { message: makeMessage('status', parts.join(' | ')) };
         }
```

The existing `diff_proposed` / `install_proposed` cases set `pendingApproval` of kind `edit`
/ `install` instead of the old `pendingReview` / `pendingInstall` fields.

**`AppController.tsx`** — one `pendingApproval` state replaces the two; `handleReviewDecision`
clears the single slot; the script view renders from `kind: 'script'`. The `onApproval`
resolver mechanism ([AppController.tsx:88](../tyla/src/tui/controller/AppController.tsx#L88)) is
**unchanged** — it already resolves whatever `handleReviewDecision` passes, so the tutor's
`execute_script` approval rides the exact path the edit approval uses today.

**Review §7 — `file_loaded` was never emitted.** The §6 table in the first draft listed a
`file_loaded` handler, but `dispatchLoadFile` (§5c) emits **`text_output`** (already handled
by the mapper). **Decided: no `file_loaded` event/handler** — the decision-doc flowchart was
aspirational; `text_output` is correct for Phase 1. The table below is corrected accordingly.

| TUI surface | Change |
|-------------|--------|
| `types.ts` | `PendingApproval` union (replaces `pendingReview`/`pendingInstall`) |
| `event-mapper.ts` | NEW `script_proposed`, `script_rejected` cases; `info` added to `status_update`; `diff_proposed`/`install_proposed` retargeted to the union |
| `AppController.tsx` | single `pendingApproval` state; script-kind render; resolver path unchanged |
| ~~`file_loaded` handler~~ | **dropped** — `dispatchLoadFile` emits `text_output` (already handled) |

### 6.2 Composition root — `infrastructure/bootstrap/agent-factory.ts`

`ExecuteTutorUseCase` is constructed at
[`agent-factory.ts:146`](../tyla/src/infrastructure/bootstrap/agent-factory.ts#L146). Every
symbol we need is **already in scope** there — the instruction use case uses them at
lines 123–132: `diffEngine`, `approvalBus.approve.bind(approvalBus)` (the `onApproval`
handler), and a shared `stagingService`. Add the guard gateway next to the tutor gateway and
thread the gate in:

```diff
+// review §2: gate on the env flag AND a profile — not on profile alone. Default-off means
+// merging this changes nothing until TYLA_GUARD_PRECALL=1 is set (after backend WS-A).
+const guardPrecallEnabled = ['1', 'true'].includes((getEnv(ENV_VARS.GUARD_PRECALL) ?? '').toLowerCase());
+const guardCheckGateway = guardPrecallEnabled && getProfile(directory)
+    ? new GuardCheckGateway((msg) => emit('status_update', { warning: msg }), directory)
+    : undefined;

 const tutorUseCase = new ExecuteTutorUseCase(
-    { llm, registry, directory, emit, policyLoader: assignmentPolicyLoader, tutorChatGateway },
+    { llm, registry, directory, emit, policyLoader: assignmentPolicyLoader,
+      tutorChatGateway, guardCheckGateway,
+      onApproval: approvalBus.approve.bind(approvalBus),   // same gate as instructionUseCase (line 128)
+      diffEngine,
+    },
     modeManager.getMode(),
 );
```

> **Do NOT pass the shared `stagingService`** (the one at line 129, used by
> `instructionUseCase`). The tutor dispatch stages per-action via the new `stageOnly()` (§5c)
> — which never touches `_staged` — and applies immediately. Pass only `diffEngine` and let
> §5a's constructor build the tutor its **own** `EditStagingService`; the instruction
> pipeline's `drainStagedEdits()` then can never see a tutor-staged edit.
>
> **Until WS-A (`guardPrecallEnabled === false`)** `guardCheckGateway` is `undefined`, so the
> Option B path is dormant: `callGateway()`'s §5b early check returns the friendly
> "backend not configured" error rather than dereferencing `undefined`. Existing
> `tutorChatGateway`-only behaviour is untouched. **When WS-A ships**, set
> `TYLA_GUARD_PRECALL=1` and the full guard→tutor→actions pipeline activates with no code
> change.
>
> `onApproval` reuses `approvalBus` — the same bus `instructionUseCase` uses — so the tutor's
> `edit_file` / `execute_script` approvals flow through the §6.1 TUI gate already in place.

---

## 7. Tests to add / update (Vitest)

| File | What |
|------|------|
| `tests/guard-check-gateway.test.ts` (new) | mock `axios.post`; assert `done`/`forbidden`/**`error`**/`unavailable` → correct `GuardCheckResult` (incl. the `error` branch carrying `message`, no `logId`); 401 missing-key path; `parseUsage` clamping |
| `tests/tutor-chat-gateway.test.ts` | request body includes `guard_log_id` + `file_context`; `actions` filtered through `isTutorAction` (one valid + one malformed → length 1); `forbidden` **and `error`** carry no actions |
| `tests/tutor-actions.test.ts` (new) | `isTutorAction` truth table for all three types + malformed patches |
| `tests/execute-tutor-use-case.test.ts` | guard `forbidden` short-circuits (no tutor call); guard **`error` → emits error, no tutor call, no log_id leaked**; tutor **`error` → emits error + retry, no dispatch**; `done` → tutor called with `logId`; `edit_file` action → `onApproval` gate → `applyEdit` only when approved; `execute_script` **rejected → `script_rejected`, no `r_exec`**; **no `guardCheckGateway` (flag off) → friendly thrown error, not `TypeError`**; usage = guard + tutor |
| `tests/execute-tutor-use-case.test.ts` (file_context) | named file → `file_context` contains only that file (incl. a named `.pdf` — name-only path); **no name → `readFallbackFiles` loads top-N `rScripts` first**, skips `dataFiles`/`rData`/`documents`, stops at `MAX_CONTEXT_TOKENS`; empty workspace → listing-only string |
| `tests/edit-staging-service.test.ts` | **`stageOnly()` does NOT push to `_staged`** (drain stays empty after a stage+apply); stores relative `path` + resolved `absPath`; `applyEdit` writes to `absPath` (tutor `directory`, not cwd) |
| `tests/event-mapper.test.ts` | **`script_proposed` → `pendingApproval` kind `script` + `reviewing`** (the deadlock regression test); `script_rejected` → "Skipped script" status; `status_update.info` surfaces (review §6); `diff_proposed`/`install_proposed` produce the union variants |

Mock class constructors with `vi.fn(function () { return {...}; })` (arrow fns can't be
`new`-ed) — per the project testing note.

---

## 8. Sequencing

1. **§2 + §3 + §4a/§4b + §5a–§5d + §6.1** behind the gateway path — additive, safe to merge
   before the backend is live (`actions` stays `[]`, `guard_log_id` is sent and ignored until
   WS-B; `TYLA_GUARD_PRECALL` stays off so `callGateway` isn't reached). **§6.1 must land in
   this batch** — without the `script_proposed` mapper case the first `execute_script` action
   deadlocks the TUI (review §1).
2. Backend WS-A green → set `TYLA_GUARD_PRECALL=1` (status enum live). WS-B green → `actions[]`
   start flowing; dispatch already handles them.
3. **§5e** (fallback removal) as a follow-up commit once 1–2 are verified end-to-end — land it
   *with or after* §5b's early gateway check (review §4), never before.

### Open / confirm (resolved items from the review marked **RESOLVED**)
- **Approval deadlock — RESOLVED in §6.1 (review §1, blocking).** `script_proposed` /
  `script_rejected` mapper cases added; the two parallel slots consolidated into one
  `pendingApproval` union (Option C).
- **Guard config flag — RESOLVED in §3 + §6.2 (review §2, blocking).** `TYLA_GUARD_PRECALL`
  env flag, default-off; gateway constructed only when flag + profile both present.
- **`'error'` status — RESOLVED in §3/§4a/§5b (review §3).** Both gateways carry an `error`
  variant; `callGateway()` shows the error + retry hint and never proceeds with a null
  `log_id`.
- **Unguarded `guardCheckGateway!` — RESOLVED in §5b/§5e (review §4).** Early
  `if (!gateway) throw <friendly>` replaces the bare `!` assertion.
- **`_staged` accumulation — RESOLVED in §5c (review §5).** New `stageOnly()` skips the queue.
- **`status_update.info` dropped — RESOLVED in §6.1 (review §6).** `info` case added.
- **`file_loaded` mismatch — RESOLVED in §5c/§6.1 (review §7).** Dropped; `dispatchLoadFile`
  emits `text_output`.
- **Path display — RESOLVED in §5c (review §9).** `stageOnly()` keeps the relative path for
  the diff header, resolves `absPath` for apply.
- **TutorResult `actions` — NOTED, intentionally out of scope (review §8).** Phase 1 does not
  persist proposed actions in session history; TODO recorded in §5b for Phase 2 / Option A.

Still genuinely open (no review finding — design choices):
- **No-filename file_context — RESOLVED in §5d(iv).** `readFallbackFiles()` reads the top-N
  source files when nothing is named: `FALLBACK_FILE_LIMIT = 5`,
  `FALLBACK_GROUPS = ['rScripts', 'rMarkdown']`, budget-capped at `MAX_CONTEXT_TOKENS`.
  **Decided:** `documents` (assignment PDFs) are **name-only** — never auto-loaded (large,
  and the assignment policy may already carry their content). N (5) is tunable but needs no
  decision to ship.
- **Usage surfacing:** §5b sums guard + tutor into one `TurnUsage`. If the token status bar
  wants the split (`guardUsage` / `tutorUsage`), emit a `status_update` with both and let
  the bar add — the sum here is only for the persisted turn. (Disjoint, so either way is
  correct; no double-count.)
- **`load_file` in Option B:** single-roundtrip means there's no follow-up LLM turn to
  consume the loaded file, so it only surfaces content to the student. It earns its keep
  under Option A (multi-roundtrip) — keep the dispatch arm, low priority.

---

## 9. Future: multi-language (Python) — the seam, not the build

**Not in scope for Phase 1.** Today the tool *is* an R/RStudio assistant, so R-only context
is correct — it only looks odd once Python actually ships. The professor's "maybe later" is a
signal to keep the R assumptions **isolated behind a clear seam**, not to build a
multi-language framework now (YAGNI). This section records where the seam is so Python becomes
a *bounded* change, and so nobody mistakes the file_context fallback for the hard part.

**Where the R-coupling actually lives** (deep → shallow):

| Layer | Coupling | What Python needs |
|-------|----------|-------------------|
| `file_scan` tool (the classifier) | **deep — the real prerequisite** | group names `rScripts / rMarkdown / rData / rProject` are R-specific; `.py` / `.ipynb` aren't scanned into `scannedFiles` **at all** today. Add a `pythonScripts` (and `notebooks`) group, or generalise to a language-tagged `sourceFiles` group. |
| `r_exec` tool + `execute_script` dispatch (§5c) | **deep** | `r_exec` runs `Rscript`. Route by language: `execute_script` gains a `language` (or the backend emits `py_exec`), dispatch picks `r_exec` / `py_exec`. The read-only guard pattern ports directly. |
| tutor system prompt / policy | **medium** | currently R-flavoured pedagogy; needs per-language (or language-neutral) variants. |
| **§5d `readFallbackFiles` (this plan)** | **shallow — one line** | once `file_scan` surfaces Python, add `'pythonScripts'` to `FALLBACK_GROUPS`. Nothing else in this plan changes. |

**Order of work, if/when it lands:** `file_scan` taxonomy **first** (until `.py` is in
`scannedFiles`, every downstream change is inert) → `execute_script` language routing →
prompt/policy variants → the `FALLBACK_GROUPS` one-liner falls out for free.

**Naming stance taken here:** the plan talks about "source files", not "R files", and the
language-specific knowledge is concentrated in two named constants (`FALLBACK_GROUPS`) and two
tools (`file_scan`, `r_exec`). That's the whole seam — no speculative abstraction layer until
there's a second language to justify it.

> **Cross-repo note:** Python support is **not** frontend-only — the backend tutor prompt and
> any server-side language assumptions move with it. Capture it in
> `Tyla-api/plans/` before starting, the same way this pipeline was split frontend/backend.
