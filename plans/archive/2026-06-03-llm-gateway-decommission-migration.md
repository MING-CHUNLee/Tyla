# LLMGateway Decommission — Frontend-Cannot-Call-Provider Migration

> **Status: ANALYSIS / migration map (2026-06-03).** Records every place the frontend still
> calls an LLM provider directly via the domain `LLMGateway` interface (concrete
> `infrastructure/api/llm/gateway/llm-gateway.ts`), maps each to its target backend
> (**guard** or **tutor**), and **cross-checks coverage against**
> [`2026-06-03-option-b-frontend-implementation.md`](2026-06-03-option-b-frontend-implementation.md).
>
> **Goal (policy):** the frontend must not call any LLM provider itself. All inference goes
> through the backend: safety via `GuardCheckGateway` → `POST /api/v1/guard_checks`, and all
> answer/edit/analysis generation via `TutorChatGateway` → `POST /api/v1/tutor_chats`
> (returns `actions[]`).
>
> **Companion docs:** Option B frontend plan (the tutor-path enablement) and the decision doc
> [`2026-06-03-agentic-tutor-react-pipeline.md`](2026-06-03-agentic-tutor-react-pipeline.md).

---

## 0. Current state — dual-track routing

The TUI today runs **two parallel pipelines**, selected by workflow mode in
[`agent-service.ts:262-311`](../tyla/src/application/services/agent-service.ts#L262):

| Mode | Path | LLM call site |
|------|------|---------------|
| **non-default** (workflow mode active) | `ExecuteTutorUseCase` → guard + tutor backend | ✅ **backend** (no `LLMGateway`) |
| **default** | `IntentRouter.classify` → `ask` / `run` / `install` / `instruction` use-cases | ❌ **direct provider** via `LLMGateway` |

So the new backend path already exists, but **default mode still calls the provider directly**.
The migration is: route default mode through the same guard + tutor backend, then delete the
direct-LLM machinery.

**Target backend semantics**

- **guard backend** = safety judgement (replaces the offline LLM judge `GuardAgent`).
- **tutor backend** = all answer / edit / analysis text generation + prompt composition + the
  real provider call; returns `actions[]` (`edit_file` / `execute_script` / `load_file`).

---

## 1. Migration map — every `LLMGateway` consumer

### Use-cases

| Use-case | Current LLM use | Target backend | Migration action / status |
|----------|-----------------|----------------|----------------------------|
| [ExecuteTutorUseCase](../tyla/src/application/use-cases/execute-tutor-use-case.ts) | none (no `LLMGateway`) | guard + tutor | ✅ **Done** — reference template for the new path |
| [ExecuteAskUseCase](../tyla/src/application/use-cases/execute-ask-use-case.ts) | `llm.streamPrompt` — Q&A answer | **tutor** | ask = "tutor with no actions". Route through tutor gateway; reuse tutor's `file_context` assembly |
| [ExecuteInstructionUseCase](../tyla/src/application/use-cases/execute-instruction-use-case.ts) | ReAct edit generation via Orchestrator/Evaluator | **tutor** | Largest piece. Tutor's `edit_file` action replaces the whole ReAct/orchestrator/evaluator stack |
| [ExecuteRunUseCase](../tyla/src/application/use-cases/execute-run-use-case.ts) | only `streamAnalysis` uses `llm.streamPrompt` to analyse R output | **tutor** | Script-find + R-exec are local, **keep**; only the analysis-text generation crosses to tutor |

### Services / orchestration

| Component | Current LLM use | Target | Migration action / status |
|-----------|-----------------|--------|----------------------------|
| [GuardAgent](../tyla/src/application/services/guard-agent.ts) | `llm.sendPrompt` JSON safety judge | **guard** | ⚠️ **Already dead code** — replaced by [GuardCheckGateway](../tyla/src/infrastructure/api/guard/guard-check-gateway.ts); no longer constructed anywhere. Safe to delete |
| [IntentRouter](../tyla/src/application/services/intent-router.ts) | `llm.sendPrompt` for ambiguous classification | **eliminate / tutor** | New path is mode-driven, no client classification. Keep the regex pre-check local; drop the LLM fallback or move it server-side |
| [HistorySummarizer](../tyla/src/application/services/history-summarizer.ts) | `llm.sendPrompt` to compress history | **tutor** (or backend-owned context) | Summarization moves server-side |
| [Orchestrator](../tyla/src/application/orchestration/orchestrator.ts) | ReAct edit generation | **tutor** | Subsumed by tutor actions → delete |
| [react-loop](../tyla/src/application/orchestration/react-loop.ts) | ReAct THOUGHT/ACTION loop | **tutor** | → delete |
| [Evaluator](../tyla/src/application/services/evaluator.ts) | `retryWithCorrection` to fix edit artifacts | **tutor** (backend self-validates) | → delete |
| [file-resolver](../tyla/src/infrastructure/filesystem/file-resolver.ts) | LLM-assisted file relevance | **eliminate** | Tutor builds `file_context` with name/extension heuristics — no LLM needed |
| [stress-test-service](../tyla/src/application/services/stress-test-service.ts) | `LLMGateway` | — | Test/dev tool, not a production path; handle separately |
| [slash-command-router](../tyla/src/application/services/slash-command-router.ts) | `import type` only — no call | — | Drop the type import |

### Infrastructure wiring (the "unplug" points)

| Location | Role |
|----------|------|
| [agent-factory.ts:72](../tyla/src/infrastructure/bootstrap/agent-factory.ts#L72) | `LlmGateway.fromEnv()` — primary construction site; gone once everything migrates |
| [file-resolver.ts:49](../tyla/src/infrastructure/filesystem/file-resolver.ts#L49) | second `LlmGateway.fromEnv()` construction site |
| [agent-service.ts:277-305](../tyla/src/application/services/agent-service.ts#L277) | default-mode intent fan-out — converging this onto tutor is the final step |

### Dead / legacy directories that fall out

| Directory | Disposition |
|-----------|-------------|
| [api/llm/](../tyla/src/infrastructure/api/llm/) | Delete once no use-case depends on the domain `LLMGateway` |
| [api/logging/](../tyla/src/infrastructure/api/logging/) | `RubyLogGateway` / `PromptLogGateway` already dead; `SessionLogGateway` + `LogMapper` only serve `llm-gateway`, so they go with it |

---

## 2. Convergence route (one line)

> Route **default mode** through tutor too — ask → tutor (text only), edit → tutor `edit_file`
> actions, run → only the analysis leg crosses to tutor — with guard unified on
> `GuardCheckGateway`. Then delete in one batch: `GuardAgent`, `Orchestrator`, `react-loop`,
> `Evaluator`, the LLM part of `file-resolver`, `IntentRouter`'s LLM fallback, and the whole of
> `api/llm/` + `api/logging/`.

---

## 3. Cross-check against the Option B plan

**Option B's declared scope (§0) is exactly four tutor-path changes:** `GuardCheckGateway`,
`tutor-chat-gateway` (`guard_log_id` + `actions`), `execute-tutor-use-case` orchestration, and
the TUI approval wiring. It enables the **non-default** tutor path — it is **not** a
provider-decommission plan and never claims to be.

Measured against the dependency map in §1, here is what the plan covers vs. leaves open:

| Dependency point (from §1) | Covered by Option B? | Where / Gap |
|-----------------------------|----------------------|-------------|
| `ExecuteTutorUseCase` (guard+tutor+actions) | ✅ Yes | Plan §3–§6 — fully specified and implemented |
| `tutor-chat-gateway` `guard_log_id`/`actions` | ✅ Yes | Plan §4 |
| `GuardCheckGateway` | ✅ Yes | Plan §3 |
| TUI approval deadlock (`script_proposed`) | ✅ Yes | Plan §6.1 |
| `GuardAgent` removal | 🟡 Partial | Plan §5a/§5e drop it **from the tutor path only**. It is now globally dead code, but the plan does not call for **deleting the class/file**. → **GAP: schedule deletion** |
| **`ExecuteAskUseCase` → tutor** | ❌ **No** | Out of scope. Default-mode ask still calls `llm.streamPrompt`. **GAP** |
| **`ExecuteInstructionUseCase` → tutor** | ❌ **No** | Plan *reuses* `EditStagingService`/`onApproval` from it (§0, §5c) but never migrates its own LLM use. Default-mode edit still runs ReAct locally. **GAP** |
| **`ExecuteRunUseCase` (`streamAnalysis`) → tutor** | ❌ **No** | Not mentioned. Default-mode run still calls the provider for analysis. **GAP** |
| **`Orchestrator` / `react-loop` / `Evaluator` removal** | ❌ **No** | Not mentioned — they remain live under default-mode edit. **GAP** |
| **`IntentRouter` LLM fallback** | ❌ **No** | Not mentioned. Still calls `llm.sendPrompt` for ambiguous default-mode input. **GAP** |
| **`HistorySummarizer` → backend** | ❌ **No** | Not mentioned. Still summarizes via `llm.sendPrompt`. **GAP** |
| **`file-resolver` LLM use** | ❌ **No** | Not mentioned. Tutor path sidesteps it via heuristics, but `file-resolver.ts:49` still builds an `LlmGateway`. **GAP** |
| **`agent-service` default-mode fan-out → tutor** | ❌ **No** | Plan leaves [agent-service.ts:277-305](../tyla/src/application/services/agent-service.ts#L277) untouched; default mode is the entire untouched track. **GAP — the root convergence point** |
| **`api/llm/` deletion** | ❌ **No** | Not in scope |
| **`api/logging/` deletion** | ❌ **No** | Not in scope; `RubyLogGateway`/`PromptLogGateway` already dead |
| **`stress-test-service`** | ❌ **No** | Not in scope; dev tool |
| **`slash-command-router` type import** | ❌ **No** | Trivial; not in scope |

### Verdict

The Option B plan is **correct and complete for what it scopes** (turning on the tutor path),
but it is **not** the provider-decommission. Relative to the "frontend cannot call the LLM
provider" goal it leaves **the entire default-mode track unmigrated** — concretely:

1. **The root gap:** [agent-service.ts:277-305](../tyla/src/application/services/agent-service.ts#L277)
   still fans default mode out to four direct-LLM use-cases. Nothing in Option B touches it.
2. **Three use-cases** (`ask`, `instruction`, `run`) and their support stack
   (`Orchestrator`, `react-loop`, `Evaluator`, `IntentRouter` fallback, `HistorySummarizer`,
   `file-resolver`) still call the provider.
3. **Cleanup is unscheduled:** `GuardAgent` is dead but not deleted; `api/llm/` and
   `api/logging/` are not slated for removal.

**Recommendation:** treat Option B as Phase 1 (tutor path live). Open a **Phase 2** that
converges default mode onto the tutor/guard backend per §1–§2, after which the Phase 3 deletion
batch (`api/llm/`, `api/logging/`, `GuardAgent`, `Orchestrator`, `react-loop`, `Evaluator`,
`IntentRouter` LLM fallback) becomes mechanical.
