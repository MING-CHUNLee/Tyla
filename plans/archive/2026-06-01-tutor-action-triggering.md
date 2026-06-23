# Letting `tutor` Trigger Actions (load file / edit file / execute script)

**Date:** 2026-06-01
**Status:** Discussion / design
**Question being answered:** When the tutor LLM responds, how does our code know it should *load a file*, *edit a file*, or *execute a script* — the way `agent`/`instruction` and `install` already do? And what is the cleanest way to add this to tutor?

---

## TL;DR

- Today, `execute-tutor-use-case.ts` is **deliberately read-only**. It loads files only as *context* and returns the LLM reply as **plain text**. There is **no structure in the response that can trigger an action**.
- The codebase already has **two proven mechanisms** for triggering actions:
  - **Pattern A — ReAct markers** → triggers *load file* and *execute script* (any tool).
  - **Pattern B — Edit artifacts** → triggers *edit file* (write to disk), behind a user-approval gate.
- So adding actions to tutor is **not new infrastructure** — it is **reusing A and/or B**, plus deciding the shape of the `content` the tutor returns.
- **Recommendation:** keep *load file* on the input side (already works), and surface *edit file* / *execute script* as **proposals that the student must approve**, reusing the existing approval gate. Concretely: a **structured response envelope** (`{ text, actions[] }`) from the tutor gateway.

---

## Part 1 — How `execute-tutor-use-case.ts` works today (shallow → deep)

### Level 1: The one-sentence version

> Tutor reads some files for background, asks the LLM, and prints the answer as text. It never changes anything.

### Level 2: The pipeline

File: [execute-tutor-use-case.ts](../tyla/src/application/use-cases/execute-tutor-use-case.ts)

```
execute(instruction, history)
  │
  ├─ if a backend gateway is configured ──► callGateway()      ← the real/production path
  │                                          (POST /api/v1/tutor_chats, returns content string)
  │
  └─ otherwise (offline fallback):
       1. buildProjectContext()   → scan workspace (file_scan tool)
       2. readRelevantFiles()     → read files whose name/ext appears in the instruction
       3. runGuard()              → optional safety check (refuse / identity / allow)
       4. assemblePrompt()        → stuff context + file contents into the system prompt
       5. callLLMStream()         → stream tokens, return { content, usage }
```

### Level 3: The key detail — where do files appear, and what comes back?

- **Files are an INPUT, never an OUTPUT action.**
  `readRelevantFiles()` ([L158-190](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L158-L190)) reads file contents and concatenates them into the prompt's `## File Contents` section. This is "load file", but it happens *before* the LLM runs, purely to give it context. The LLM cannot ask for a *new* file mid-answer.

- **The output is a flat string.**
  Both `callGateway()` and `callLLMStream()` return:
  ```ts
  interface TutorResult { content: string; usage: TurnUsage; }
  ```
  and emit it with `emit('text_output', { content })`. The TUI just renders that text.

- **The backend wire format is also a flat string.**
  [tutor-chat-gateway.ts](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts#L9-L14):
  ```ts
  interface TutorChatResponse {
    log_id: number;
    status: 'done' | 'forbidden' | 'unavailable';
    content: string;          // ← just text, no actions
    usage: { input_tokens, output_tokens } | null;
  }
  ```

**Conclusion for Part 1:** there is no parser, no marker, no JSON in the tutor output path. So "the code knowing it should load/edit/execute" simply **does not exist in tutor yet** — by design, because tutor is meant to teach, not to act.

---

## Part 2 — The two patterns that DO trigger actions (so we can reuse them)

### Pattern A — ReAct markers → *load file* and *execute script*

**Where:** [react-loop.ts](../tyla/src/application/orchestration/react-loop.ts), used by the `agent`/`instruction` pipeline via the Orchestrator.

**How it works:** the LLM emits a marker inside its text:

```
[THOUGHT] I need to read the data file first
[ACTION {"tool":"file_read","input":{"path":"data.csv"}}]
```

The loop parses it with a regex ([parseReActResponse, L192-216](../tyla/src/application/orchestration/react-loop.ts#L192-L216)), runs the named tool via `registry.execute(tool, input)` ([L144-147](../tyla/src/application/orchestration/react-loop.ts#L144-L147)), and feeds the result back as `[OBSERVATION] ...`. The LLM can then continue. `[ANSWER] ...` ends the loop.

**What it gives us:**
- `file_read` / `pdf_read` → **load file** (mid-answer, on demand)
- `r_exec` → **execute script**
- `file_scan`, `library_scan`, etc. → any registered tool

**Trigger type:** *during* generation. Multi-step. Uses `sendPrompt` (not streaming).
**Safety:** none built in — the loop just runs the tool.

### Pattern B — Edit artifacts → *edit file* (with approval)

**Where:** [evaluator.ts](../tyla/src/application/services/evaluator.ts) + [execute-instruction-use-case.ts](../tyla/src/application/use-cases/execute-instruction-use-case.ts).

**How it works:** the LLM produces a JSON array as its output:

```json
[{ "path": "analysis.R", "content": "library(dplyr)\n..." }]
```

`Evaluator.validateEditOutput()` ([L41-72](../tyla/src/application/services/evaluator.ts#L41-L72)) extracts and validates that shape (retrying via the LLM if malformed). The instruction use-case then:
1. Stages each edit (computes a diff vs. the file on disk),
2. Emits `diff_proposed`,
3. Calls `onApproval(...)` — **the human-in-the-loop gate** ([L210-240](../tyla/src/application/use-cases/execute-instruction-use-case.ts#L210-L240)),
4. Writes to disk only if approved.

This is the **Phase 3 safety gate** from `CLAUDE.md`.

**What it gives us:** **edit file**, written safely.
**Trigger type:** *after* generation. Single shot. Approval-gated.

### (Bonus) Pattern C — `install` is the odd one out

[execute-install-use-case.ts](../tyla/src/application/use-cases/execute-install-use-case.ts#L59-L61) does **not** read LLM output structure at all. It regex-extracts package names from the *user's instruction*, builds a plan, emits `install_proposed`, and waits for `onApproval`. Useful as a reference for the **propose → approve → execute** event pattern, which is exactly what a tutor should do.

### Side-by-side

| | Pattern A (ReAct) | Pattern B (Edit artifacts) | Pattern C (install) |
|---|---|---|---|
| Output shape | `[ACTION {json}]` in text | JSON array `[{path,content}]` | (reads user input, not LLM) |
| Triggers | load file, execute script | edit file | install packages |
| When | during generation | after generation | after parsing instruction |
| Approval gate | ✗ | ✓ `onApproval` | ✓ `onApproval` |
| Reused infra | Orchestrator, ToolRegistry | Evaluator, EditStagingService | RInstallTool |

**Conclusion for Part 2:** every action you want already has a working mechanism. Adding it to tutor = **wiring tutor into A and/or B**, not building from scratch.

---

## Part 3 — Three ways to add this to tutor (with trade-offs)

### Option 1 — Run tutor through the ReAct loop (reuse Pattern A)

Wrap the tutor LLM call in the Orchestrator/ReAct loop, but expose **read-only tools only** (`file_read`, `pdf_read`, `r_exec`), and **withhold `file_edit`**.

- ✅ load file + execute script for free; reuses the existing parser.
- ❌ loses streaming UX (loop is multi-step `sendPrompt`); risk of the tutor *doing the work* instead of teaching.

### Option 2 — Structured response envelope (RECOMMENDED)

Change the tutor reply from a flat string to:

```ts
interface TutorReply {
  text: string;                 // what the student reads
  actions?: TutorAction[];      // optional suggestions
}
type TutorAction =
  | { type: 'load_file';      path: string }
  | { type: 'edit_file';      path: string; content: string }
  | { type: 'execute_script'; path?: string; code?: string };
```

The TUI renders `text`, then shows each `action` as a **suggestion the student must confirm**, reusing the existing `diff_proposed` / `install_proposed` + `onApproval` flow.

- ✅ matches the teaching model: tutor *proposes*, student *decides*.
- ✅ reuses the approval-gate event pattern already in the codebase.
- ✅ the backend just changed to a "status-based `/tutor_chats` response format" (commit `d51b53d`), so the wire format is already in flux — good moment to add an `actions` field.
- ❌ requires touching both the backend wire format and the frontend (`TutorChatResponse`, `TutorResult`, the TUI dispatcher).

### Option 3 — Embed markers in the text, let the TUI detect them

Keep streaming plain text but agree on a convention (e.g. a fenced ```` ```r run ```` block, or an inline edit-artifact JSON) that the TUI detects and turns into a "Run" / "Apply" button.

- ✅ smallest change; streaming preserved.
- ❌ fragile parsing; action and prose are mixed, making a clean approval gate harder.

---

## Part 4 — Recommendation

**Keep *load file* where it is (input-side context — already works), and add *edit file* / *execute script* as student-approved proposals via Option 2 (structured envelope).**

Rationale, tied to the product's purpose (tutor = teaching; the student must stay the active learner):

1. **The tutor should never act autonomously.** Pattern A's auto-execute loop (Option 1) is appropriate for `agent`, not for a tutor. A tutor that silently runs/edits code defeats the learning goal.
2. **Reuse the approval gate you already trust.** `onApproval` + `diff_proposed` (Pattern B) and `install_proposed` (Pattern C) already implement "propose → student confirms → execute". Tutor actions should flow through the same gate, so the student is always the one who decides to run or apply.
3. **The wire format is already being revised**, so adding an `actions[]` field now is low-friction.

### Suggested increments (smallest → fuller)

1. **Backend:** add optional `actions[]` to the `/tutor_chats` response.
2. **Gateway:** extend `TutorChatResponse` / `TutorChatResult` to carry `actions`; map into a new `TutorReply` (or extend `TutorResult`).
3. **Use-case:** in `callGateway()`, after `emit('text_output', ...)`, emit one proposal event per action (`diff_proposed` for `edit_file`, a new `script_proposed` for `execute_script`).
4. **TUI:** render each proposal with a confirm/cancel action wired to `onApproval`; on approve, apply via `EditStagingService` (edits) or `r_exec` (scripts).
5. **Guard:** make sure proposed actions still pass the existing guard before they can be approved.

### Files this will touch

- [tutor-chat-gateway.ts](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts) — wire + result types
- [execute-tutor-use-case.ts](../tyla/src/application/use-cases/execute-tutor-use-case.ts) — emit proposal events in `callGateway()` / `callLLMStream()`
- TUI event mapper + views — render proposals, wire `onApproval`
- (reuse, no change) [evaluator.ts](../tyla/src/application/services/evaluator.ts), `EditStagingService`, `r_exec` tool

### Explicitly out of scope

- Letting tutor write files without approval.
- Turning tutor into a full ReAct agent (that is what `agent` is for).
