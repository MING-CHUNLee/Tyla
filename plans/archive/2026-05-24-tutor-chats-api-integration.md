# Plan: Integrate POST /api/v1/tutor_chats

Date: 2026-05-24

## Overview

`POST /api/v1/tutor_chats` is the "second leg" of the guard → tutor pipeline.
It replaces the current local LLM call inside `ExecuteTutorUseCase`: instead of
the CLI composing the system prompt and calling the LLM directly, the backend
handles guard (server-side, defence in depth), loads assignment artefacts from
disk, composes the tutor system prompt, and returns the tutor reply.

The CLI becomes a thin client — it sends `{ course_id, project_id, student_id,
prompt, history }` and receives `{ log_id, allowed, content, usage }`.

---

## Current flow (before)

```
ExecuteTutorUseCase.execute()
  1. file_scan  — scan local workspace
  2. file_read  — read files mentioned in prompt
  3. GuardCheckGateway → POST /api/v1/guard_checks
  4. buildTutorModePrompt() — assemble system prompt locally
  5. llm.streamPrompt()    — call LLM directly
```

## Target flow (after)

```
ExecuteTutorUseCase.execute()
  1. TutorChatGateway → POST /api/v1/tutor_chats
       (backend: guard → load artefacts → compose prompt → call tutor LLM)
  2. Handle response: allowed / blocked / guard-skipped (202)
```

The local guard check (step 3 above) is dropped from the CLI because the
backend re-runs the guard on every call. The local workspace scan is also
dropped for Phase 1 (server loads student WIP from fixtures). Phase 2 will
add the student's actual workspace file in the request body — that is out of
scope here.

---

## Files to create

### `tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts`

New HTTP gateway. Mirrors the structure of `GuardCheckGateway` but targets
`/api/v1/tutor_chats`.

**Request shape sent to API:**
```ts
{
  course_id:  string;   // from profile.courseId
  project_id: string;   // from profile.projectId
  student_id: string;   // from profile.studentId
  prompt:     string;   // the student's message
  history?:   Array<{ role: 'user' | 'assistant'; content: string }>;
}
```

**Headers forwarded:**
| Header | Source |
|---|---|
| `Content-Type` | `application/json` |
| `X-LLM-Key` | `getApiKeyForProvider(provider)` |
| `X-LLM-Provider` | `detectProvider()` |
| `X-LLM-Model` | `getEnv(ENV_VARS.LLM_MODEL)` |
| `X-LLM-Endpoint` | `getEndpointForProvider(provider)` |

**Response variants handled:**

| HTTP | `allowed` | Action |
|---|---|---|
| 200 | `true` | Return `{ logId, content, usage }` |
| 200 | `false` | Return `{ logId, allowed: false, refusal, attackProbability, evaluation }` |
| 202 | — | Guard skipped; still return content with `warning` |

**Fail-open:** any network / timeout / non-2xx error propagates as a thrown
error (the caller in `ExecuteTutorUseCase` can catch and emit an `error`
event).

**Domain result type** (returned to use case):
```ts
export type TutorChatResult =
  | { allowed: true;  logId: number; content: string; usage: { inputTokens: number; outputTokens: number }; warning?: string }
  | { allowed: false; logId: number; refusal: string; attackProbability: number; evaluation: string };
```

---

## Files to modify

### `tyla/src/application/use-cases/execute-tutor-use-case.ts`

**Add dependency:**
```ts
export interface ExecuteTutorDeps {
  // ... existing fields ...
  tutorChatGateway?: TutorChatGateway;  // injected when backend mode is active
}
```

**Replace `callLLMStream` call** with a branch:
- If `deps.tutorChatGateway` is present → call gateway, map result to
  `TutorResult`.
- Else → keep existing local `llm.streamPrompt` path (fallback / offline mode).

**Drop `runGuard`** when gateway is active — the server re-runs the guard;
calling `/guard_checks` separately would duplicate the round-trip.

**Handle blocked response** from the gateway the same way `runGuard` currently
handles a refused guard result: emit `guard_blocked` and return the refusal
text as `content`.

**Streaming note:** the REST endpoint returns the full reply in one JSON body
(no SSE). Token-by-token `stream_token` events will not fire during a gateway
call. Emit a single `text_output` event with the full content instead. This is
a known regression; streaming from the backend is a Phase 2 concern.

**Emit `phase_start` / `phase_end`** around the gateway call with
`phase: 'tutor'` to keep the UI consistent.

Concrete diff sketch:
```ts
// Before
const guardBlock = await this.runGuard(instruction, history);
if (guardBlock) return guardBlock;
this.deps.emit('phase_start', { phase: 'tutor', ... });
const systemPrompt = this.assemblePrompt(...);
return this.callLLMStream(systemPrompt, instruction, history);

// After
this.deps.emit('phase_start', { phase: 'tutor', description: 'Calling tutor API' });
if (this.deps.tutorChatGateway) {
    return this.callGateway(instruction, history);
}
// Fallback: local guard + local LLM (unchanged)
const guardBlock = await this.runGuard(instruction, history);
if (guardBlock) return guardBlock;
const systemPrompt = this.assemblePrompt(...);
return this.callLLMStream(systemPrompt, instruction, history);
```

---

### `tyla/src/infrastructure/bootstrap/agent-factory.ts`

Instantiate `TutorChatGateway` and inject it into `ExecuteTutorUseCase`:

```ts
import { TutorChatGateway } from '../api/tutor/tutor-chat-gateway';

// after existing guard setup:
const tutorChatGateway = new TutorChatGateway(
    (msg) => emit('status_update', { warning: msg }),
);

const tutorUseCase = new ExecuteTutorUseCase(
    {
        llm, registry, directory, emit,
        policyLoader: assignmentPolicyLoader,
        guardAgent,
        tutorChatGateway,          // ← new
    },
    modeManager.getMode(),
);
```

Whether to activate the gateway can be controlled by an env var
(`TYLA_API_HOST` present) or by a flag passed into `buildAgentDeps`.

---

### `tyla/src/infrastructure/api/index.ts`

Export `TutorChatGateway` and `TutorChatResult`:
```ts
export { TutorChatGateway } from './tutor/tutor-chat-gateway';
export type { TutorChatResult } from './tutor/tutor-chat-gateway';
```

---

## History format mapping

The API expects history as:
```json
[{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }]
```

**No additional mapping is needed.** The session JSON stores turns as
`{ userMessage, assistantMessage }` (no `role` field), but the domain layer
already handles the conversion:

```
ConversationSession.getHistory()
  → flatMap(turn => turn.toHistoryMessages())
  → [{ role: 'user', content: ... }, { role: 'assistant', content: ... }, ...]

AgentService.prepareHistory()
  → returns SessionMessage[] = Array<{ role: 'user' | 'assistant', content }>
```

By the time `history` arrives at `ExecuteTutorUseCase.execute()`, it is
already the flat role-based format the API expects. The gateway can forward it
directly without any transformation.

Client-side: use the existing `compactHistory` helper to trim to a safe length
before sending (server also caps at 500 KB).

---

## Error handling

| Condition | CLI behaviour |
|---|---|
| `401` — missing LLM key | `emit('error', { message: 'tutor-api: missing LLM key' })` |
| `404` — artefact missing | `emit('error', { message: 'tutor-api: assignment artefact not found' })` |
| `500` — DB write failed | `emit('error', ...)` — do not retry |
| `502` — tutor LLM non-2xx | `emit('error', ...)` |
| `504` — tutor LLM timeout | `emit('error', ...)` |
| Network error / timeout | Rethrow; `execute()` catches and emits `phase_end` with `success: false` |

---

## What is NOT changed

- `GuardCheckGateway` and `/api/v1/guard_checks` remain for non-tutor modes.
- `ExecuteAskUseCase` and `ExecuteInstructionUseCase` are untouched.
- Local fallback path in `ExecuteTutorUseCase` is preserved for offline use.
- `PromptLogGateway` continues to fire independently.

---

## Implementation order

1. Create `TutorChatGateway` (`infrastructure/api/tutor/tutor-chat-gateway.ts`)
2. Add `tutorChatGateway?` to `ExecuteTutorDeps`; implement `callGateway()` branch
3. Update `agent-factory.ts` to wire gateway into tutor use case
4. Export from `infrastructure/api/index.ts`
5. Manual smoke test: `bun run tyla -- agent "why does Freedman-Diaconis use IQR?"` with `TYLA_API_HOST` set
