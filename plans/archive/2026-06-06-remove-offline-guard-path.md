# Plan: Remove Offline Guard Path

**Goal**: Delete the local-LLM guard agent (offline path) and all its dependencies. The current codebase routes 100 % of tutor traffic through `GuardCheckGateway` (backend HTTP). No code calls `GuardAgent` anymore; all offline artefacts are dead weight.

---

## Background

`GuardAgent` was the original offline safety judge: it sent the student's prompt to a local LLM, parsed a JSON `{attack-probability}` response, and either allowed or refused. When Option B (backend API) became the only supported path (decision doc §1), `GuardAgent` lost its caller. The class and all its supporting files were left in place.

The offline types (`IGuardAgent`, `GuardLogEntry`, `GuardResult`, `GuardProbability`, `GUARD_ATTACK_THRESHOLD`) are defined in `domain/types/guard-agent.ts` and are only consumed by the offline artefacts — they are not shared with the live backend path.

`ExecuteTutorUseCase` still holds two offline leftovers:
- `export type TutorStyle` — a re-export that only fed the offline guard files.
- `private readonly style: WorkflowMode` — constructor parameter that was passed to the offline guard; `this.style` has zero reads in the class body.

---

## Files to delete

| # | File | Why |
|---|------|-----|
| 1 | `tyla/src/application/services/guard-agent.ts` | `GuardAgent` class — offline LLM judge, no callers |
| 2 | `tyla/src/application/prompts/guard-agent.ts` | `buildJudgeSystemPrompt()` + `buildRefusalInstruction()` — only used by `GuardAgent` |
| 3 | `tyla/src/domain/types/guard-agent.ts` | All offline types: `IGuardAgent`, `GuardLogEntry`, `GuardProbability`, `GuardResult`, `GUARD_ATTACK_THRESHOLD` |
| 4 | `tyla/src/infrastructure/persistence/guard-log-repository.ts` | `appendGuardLog()` — local disk log writer for offline judge; imported in `agent-factory.ts` but never called |
| 5 | `tyla/src/infrastructure/api/logging/gateway/prompt-log-gateway.ts` | `PromptLogGateway` — HTTP relay for guard log entries; not instantiated anywhere in the codebase |
| 6 | `tyla/tests/unit/application/guard-agent.test.ts` | Unit tests for the deleted `GuardAgent` |
| 7 | `tyla/src/application/prompts/guard-refusal.md` | Prompt template for offline refusal generation — backend returns its own `refusal` text |
| 8 | `tyla/src/application/prompts/guard-judge.md` | System prompt for offline LLM judge |
| 9 | `tyla/src/application/prompts/jailbreak-strategies.md` | Jailbreak catalog injected into offline judge prompt |
| 10 | `tyla/src/infrastructure/api/logging/gateway/ruby-log-gateway.ts` | `RubyLogGateway` — never instantiated anywhere in the codebase; only appears in barrel exports |

---

## Files to modify

### 1. `tyla/src/application/use-cases/execute-tutor-use-case.ts`

**a) Remove `TutorStyle` re-export (line 32)**

```ts
// DELETE:
export type TutorStyle = WorkflowMode;
```

`WorkflowMode` is still imported for the `style` constructor parameter — once that parameter is also removed (step b below), the `WorkflowMode` import from `settings` can be dropped too.

**b) Remove `style` constructor parameter (line 104)**

```ts
// BEFORE:
constructor(
    private readonly deps: ExecuteTutorDeps,
    private readonly style: WorkflowMode,   // ← delete this line
)

// AFTER:
constructor(private readonly deps: ExecuteTutorDeps)
```

`this.style` has zero reads in the class body — confirmed by grep.

**c) Update 3 stale comments**

| Location | Current text | New text |
|----------|--------------|----------|
| JSDoc lines 4–6 | `"Tutor workflow mode pipeline — Option B only (decision doc §1: the offline fallback is removed; the TUI cannot run without the backend):"` | `"Tutor workflow mode pipeline (Option B). Requires guardCheckGateway + tutorChatGateway."` |
| `execute()` line 113 | `"// Single path: the backend owns guard + prompt composition + the LLM call. The offline fallback was removed (decision doc §1). callGateway() guards against missing gateways."` | `"// Backend owns guard + prompt composition + LLM call. callGateway() guards against missing gateways."` |
| `truncateToTokenBudget` call line 300–302 | `"// Same MAX_CONTEXT_TOKENS cap the offline assemblePrompt() applies — enforced here\n// so the frontend controls exactly what crosses the wire."` | `"// Cap file context so the backend never receives an oversized payload."` |

---

### 2. `tyla/src/application/prompts/index.ts`

Remove the `guard-agent` re-export block (lines 7–10):

```ts
// DELETE:
export {
    buildJudgeSystemPrompt,
    buildRefusalInstruction,
} from './guard-agent';
```

---

### 3. `tyla/src/infrastructure/api/logging/index.ts`

Remove two dead gateway exports:

```ts
// DELETE:
export { PromptLogGateway } from './gateway/prompt-log-gateway';
export { RubyLogGateway } from './gateway/ruby-log-gateway';
```

`SessionLogGateway` and `LogMapper` are live (`llm-gateway.ts` instantiates them) — leave them.

---

### 4. `tyla/src/infrastructure/api/index.ts`

Remove `RubyLogGateway` from the logging barrel (line 25):

```ts
// BEFORE:
export { RubyLogGateway, SessionLogGateway } from './logging';

// AFTER:
export { SessionLogGateway } from './logging';
```

---

### 5. `tyla/src/infrastructure/bootstrap/agent-factory.ts`

**a) Remove dead import (line 51)**

```ts
// DELETE:
import { appendGuardLog } from '../persistence/guard-log-repository';
```

**b) Remove `style` argument from `ExecuteTutorUseCase` constructor call (line 159)**

```ts
// BEFORE:
const tutorUseCase = new ExecuteTutorUseCase(
    {
        registry, directory, emit, policyLoader: assignmentPolicyLoader,
        tutorChatGateway, guardCheckGateway,
        onApproval: approvalBus.approve.bind(approvalBus),
        diffEngine,
    },
    modeManager.getMode(),   // ← delete this argument
);

// AFTER:
const tutorUseCase = new ExecuteTutorUseCase({
    registry, directory, emit, policyLoader: assignmentPolicyLoader,
    tutorChatGateway, guardCheckGateway,
    onApproval: approvalBus.approve.bind(approvalBus),
    diffEngine,
});
```

`modeManager` is still constructed and returned in `AgentServiceDeps` — only the `tutorUseCase` argument is removed.

---

## Execution order

1. Delete 10 files (steps can be done in any order).
2. Modify `execute-tutor-use-case.ts` — remove `TutorStyle`, `style` param, 3 comments, and (now unused) `WorkflowMode` import.
3. Modify `application/prompts/index.ts` — remove guard-agent re-exports.
4. Modify `infrastructure/api/logging/index.ts` — remove `PromptLogGateway` export.
5. Modify `infrastructure/bootstrap/agent-factory.ts` — remove dead import + constructor arg.
6. Run `cd tyla && bun run build` — expect zero TypeScript errors.
7. Run `bun run test` — guard-agent test file is gone; all remaining tests should pass.

---

## Scope boundaries

- Do **not** remove `ModeManager` or `modeManager.getMode()` — they are used elsewhere in `AgentServiceDeps`.
- Do **not** touch `GuardCheckGateway` (`infrastructure/api/guard/guard-check-gateway.ts`) — this is the live Option B HTTP client; it stays.
- Do **not** touch `GuardCheckResult` in `guard-check-gateway.ts` — different type from the deleted `GuardResult`.
- No logic changes — pure dead-code removal only.
