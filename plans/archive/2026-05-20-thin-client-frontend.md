# Plan — Thin Client Frontend (Tyla TUI)

> **Date:** 2026-05-20
> **Branch:** `refactor/thin-client`
> **Companion plan:** `Tyla-api/plans/2026-05-20-tutor-orchestration-backend.md`

## Background & decisions

Tutor pipeline is currently fully in-process on the frontend: it loads policy
markdown, runs an LLM-as-judge GuardAgent, then calls the LLM directly. This
leaks the policy text and the jailbreak catalog to every student machine, and
lets a determined student strip the guard by editing local source.

**Decisions agreed with user:**

| Topic | Decision |
|---|---|
| Scope of migration | Only `tutor-socratic` and `tutor-guide` modes. `default` / `solver` (and ask / edit / run) keep calling the LLM directly from the TUI. |
| Backend endpoint | Repurpose `POST /api/v1/prompt_logs` — same path, new request/response schema. |
| LLM key transport | HTTP headers `X-LLM-Provider` and `X-LLM-Key`. Backend never persists them; passes through to the upstream LLM. |
| Frontend guard | **Fully removed.** All guard logic is server-side. |
| HW solutions | Backend stubs the solution-injection step (TODO). Frontend ships nothing solution-related. |
| Streaming | First version is non-streaming. TUI shows "thinking..." until full content arrives. (Re-enable streaming after V1 stabilizes.) |

## Out of scope

- `default` / `solver` modes — unchanged.
- ReAct pipeline / `file_edit` tool gate — unchanged.
- Plugin loader, mode manager, settings file — unchanged.
- Backend-side solution storage / retrieval (separate follow-up).

---

## What gets removed from the frontend

| Path | Action |
|---|---|
| `tyla/src/tutors/` (all 4 mode dirs) | **Delete**. Moves to backend `policies/`. |
| `tyla/src/application/services/guard-agent.ts` | **Delete**. Moves to backend `domain/services/`. |
| `tyla/src/application/prompts/guard-agent.ts` | **Delete** (judge & refusal prompt builders). Moves to backend. |
| `tyla/src/application/prompts/jailbreak-strategies.ts` | **Delete**. Moves to backend (must not ship to students). |
| `tyla/src/infrastructure/config/policy-loader.ts` | **Delete**. No more local policy resolution. |
| `tyla/src/infrastructure/persistence/guard-log-repository.ts` | **Delete**. Backend is sole log writer. |
| `tyla/src/domain/types/guard-agent.ts` | **Trim**. Keep `GuardResult` discriminated union (TUI still renders a "refused" banner) but drop policy/jailbreak references. |
| `tyla/src/infrastructure/api/logging/gateway/prompt-log-gateway.ts` | **Delete**. Logging is now an internal effect of the chat endpoint. |

## What changes shape

### `tyla/src/application/use-cases/execute-tutor-use-case.ts`

Becomes a thin caller:

```
ExecuteTutorUseCase.execute(instruction, history)
 ├── scan workspace (file_scan tool)         — unchanged
 ├── read relevant files (file_read tool)    — unchanged
 ├── build TutorChatRequest                  — NEW
 │     { course_id, project_id, student_id, mode, userPrompt, history, context.files }
 ├── tutorChatGateway.chat(request, headers) — NEW (replaces local LLM + Guard)
 │     headers: { X-LLM-Provider, X-LLM-Key }
 ├── if response.status === 'refused':
 │       emit('guard_blocked', { reason })
 │       emit('text_output', { content: response.content })
 ├── if response.status === 'ok':
 │       emit('text_output', { content: response.content })
 └── return { content, usage: response.usage }
```

Dependencies removed from `ExecuteTutorDeps`:
- `policyLoader?`
- `guardAgent?`

Added: `tutorChatGateway: TutorChatGateway` (domain interface).

### `tyla/src/infrastructure/api/tutor/gateway/tutor-chat-gateway.ts` (NEW)

Concrete fetch-based gateway, mirrors `LlmGateway` style:

```ts
class TutorChatGateway {
  async chat(req: TutorChatRequest): Promise<TutorChatResponse> {
    const res = await fetch(`${BASE_URL}/api/v1/prompt_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LLM-Provider': process.env.LLM_PROVIDER ?? 'openai',
        'X-LLM-Key':      readLLMKeyFromEnv(),
      },
      body: JSON.stringify(req),
      signal: timeoutSignal(30_000),
    });
    if (!res.ok) throw new TutorChatError(res.status, await res.text());
    return res.json();
  }
}
```

`readLLMKeyFromEnv()` reads whichever of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
/ `GEMINI_API_KEY` matches the chosen provider.

### `tyla/src/domain/ports/tutor-chat-gateway.ts` (NEW)

Domain interface so use-cases depend inward:

```ts
export interface TutorChatGateway {
  chat(request: TutorChatRequest): Promise<TutorChatResponse>;
}
```

### `tyla/src/infrastructure/bootstrap/agent-factory.ts`

- Remove construction of `GuardAgent`, `PolicyLoader`, `PromptLogGateway`, `appendGuardLog` hook.
- Remove `assignmentPolicyLoader`.
- Build `TutorChatGateway` and inject into `ExecuteTutorUseCase`.
- `LlmGateway` construction stays — still used by ask/edit/run/install.

### `tyla/src/application/services/agent-service.ts`

No surface change. `executeInstruction` still routes non-default modes to
`tutorUseCase.execute()` — only the use-case internals change.

### `tyla/.env.example`

- `TYLA_API_HOST` / `TYLA_API_PORT` move from "optional logging" to **required for tutor modes**. Add a comment to that effect.
- LLM keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) remain in the client `.env` — they are forwarded per-request to backend via headers.

---

## Test changes

| Test | Action |
|---|---|
| `tests/unit/application/execute-tutor-use-case.test.ts` | Rewrite: mock `TutorChatGateway`, assert (a) refusal branch emits `guard_blocked`, (b) ok branch emits `text_output`, (c) request body shape (`mode`, `course_id`, etc.), (d) headers carry LLM key/provider. |
| `tests/unit/.../guard-agent.test.ts` (if exists) | Delete with the source file. |
| `tests/unit/infrastructure/policy-loader.test.ts` (if exists) | Delete. |
| New: `tests/unit/infrastructure/tutor-chat-gateway.test.ts` | Mock `fetch`; assert URL, headers, timeout behavior, JSON parse, error propagation. |
| `tests/acceptance/...` involving tutor mode | Update cassettes to point at backend response shape. |

Run `bun run test` after each delete batch — TS compiler + Vitest will catch
orphan imports.

---

## Execution order

1. **Branch:** `git checkout -b refactor/thin-client` (off `main`).
2. **Add new files first** (no breaking change yet):
   - `domain/ports/tutor-chat-gateway.ts`
   - `infrastructure/api/tutor/gateway/tutor-chat-gateway.ts`
   - Skip wiring it in `agent-factory.ts` until step 4.
3. **Refactor `execute-tutor-use-case.ts`** to accept `TutorChatGateway`, keep
   the old policy/guard branch behind a feature flag so tests still pass during
   the transition. Update the use-case test.
4. **Wire backend gateway in `agent-factory.ts`** (still keeps Guard/Policy
   construction temporarily, just unused).
5. **Switch tutor use-case to backend path** (remove old branch & flag).
6. **Delete dead files** in the order below, running `bun run test` after each
   batch to surface stragglers:
   - 6a. `application/services/guard-agent.ts` + `prompts/guard-agent.ts` + `prompts/jailbreak-strategies.ts`
   - 6b. `infrastructure/config/policy-loader.ts`
   - 6c. `infrastructure/persistence/guard-log-repository.ts`
   - 6d. `infrastructure/api/logging/gateway/prompt-log-gateway.ts`
   - 6e. `src/tutors/` (whole directory)
   - 6f. `domain/types/guard-agent.ts` → keep only `GuardResult` (or move to `domain/values/tutor-chat-result.ts`).
7. **Update `.env.example`** comments.
8. **`bun run build` + `bun run test`** — must both pass.
9. Manual smoke test: launch TUI in `tutor-socratic` mode with backend running, send a benign question and an attack-style question; verify backend events flow.

Frontend cannot fully run until the matching backend branch is merged — keep
both branches in lockstep during PR review.

---

## Risk & rollback

- **Backend down → tutor mode dead.** Acceptable for V1 (tutor is the only
  affected mode). Surface a clear error event when fetch fails.
- **LLM key forwarded in clear** over HTTP. Mitigation: backend must be HTTPS
  in any non-dev deployment. Add to `Tyla-api` plan.
- **Rollback** = revert this branch; old `tutor/` policy files are in git
  history.
