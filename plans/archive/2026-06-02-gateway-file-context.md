# Gateway Path: File Context Injection

**Date:** 2026-06-02
**Status:** Proposed
**Problem:** `callGateway()` sends no file context to the backend. The offline fallback correctly scans the workspace and injects relevant file contents into the system prompt, but the production (gateway) path does not — so the tutor LLM answers without seeing the student's actual code.

---

## Part 1 — Gap Analysis

### What offline does (works correctly)

```
execute(instruction, history)
  └─ offline fallback:
       1. buildProjectContext()   → file list + project name
       2. readRelevantFiles()     → file contents matched to instruction
       3. assemblePrompt()        → injects both into system prompt
       4. callLLMStream()         → LLM sees the code
```

### What gateway does (missing context)

```
execute(instruction, history)
  └─ callGateway()
       └─ POST /api/v1/tutor_chats
            { course_id, project_id, student_id, prompt, history }
            ← no file_context field at all
```

**Result:** if a student asks "why does my `hw11.R` fail?", the backend LLM has no way to see the code unless the student pastes it manually.

---

## Part 2 — Proposed Wire Format Change

Add one optional field to the request body:

```ts
// tutor-chat-gateway.ts  — POST body
interface TutorChatRequest {
    course_id:    string;
    project_id:   string;
    student_id:   string;
    prompt:       string;
    history:      SessionMessage[];
    file_context?: string;   // ← NEW: pre-assembled, token-budgeted string
}
```

`file_context` is a plain text block already assembled and truncated by the frontend (same budget logic as offline path). The backend injects it verbatim into the system prompt under a `## File Context` heading.

**Why assemble on the frontend?**
- The backend is remote and cannot access the student's local filesystem.
- Reuses the `buildProjectContext()` + `readRelevantFiles()` logic already tested in the offline path.
- Keeps token budgeting in one place (frontend controls what gets sent).

---

## Part 3 — Files to Change

### Frontend

| File | Change |
|------|--------|
| [execute-tutor-use-case.ts](../tyla/src/application/use-cases/execute-tutor-use-case.ts) | Extract `buildFileContext()` helper from offline path; call it inside `callGateway()` before `send()` |
| [tutor-chat-gateway.ts](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts) | Add `fileContext?: string` param to `send()`; include in POST body as `file_context` |

### Backend (out of scope for this repo, documented for coordination)

| Location | Change |
|----------|--------|
| `POST /api/v1/tutor_chats` handler | Accept optional `file_context` string; append `\n\n## File Context\n{file_context}` to system prompt before LLM call |

---

## Part 4 — Implementation Steps

### Step 1 — Extract `buildFileContext()` in the use-case

Refactor the existing offline path so `buildProjectContext()` + `readRelevantFiles()` are combined into a single reusable helper:

```ts
private async buildFileContext(instruction: string): Promise<string> {
    const { projectContext, scannedFiles } = await this.buildProjectContext();
    const fileContents = await this.readRelevantFiles(instruction, scannedFiles);

    const parts: string[] = [];
    if (projectContext) parts.push(`## Project Context\n${projectContext}`);
    if (fileContents)   parts.push(`## File Contents\n${fileContents}`);
    return parts.join('\n\n');
}
```

The offline path calls `buildFileContext()` then passes the result to `assemblePrompt()` (no behaviour change).

### Step 2 — Call `buildFileContext()` inside `callGateway()`

```ts
private async callGateway(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
    this.deps.emit('phase_start', { phase: 'scan', description: 'Scanning workspace for context' });
    const fileContext = await this.buildFileContext(instruction);   // ← add
    this.deps.emit('phase_end', { phase: 'scan', success: true });

    this.deps.emit('phase_start', { phase: 'tutor', description: 'Calling tutor API' });
    const result = await this.deps.tutorChatGateway!.send(instruction, history, fileContext);  // ← pass
    // ... rest unchanged
}
```

### Step 3 — Update `TutorChatGateway.send()`

```ts
async send(
    prompt: string,
    history: SessionMessage[],
    fileContext?: string,        // ← add
): Promise<TutorChatResult> {
    // ...
    const response = await axios.post<TutorChatResponse>(
        `${this.baseUrl}/api/v1/tutor_chats`,
        {
            course_id:    profile.courseId,
            project_id:   profile.projectId,
            student_id:   profile.studentId,
            prompt,
            history,
            file_context: fileContext ?? undefined,   // ← add (omit if empty)
        },
        // ... headers unchanged
    );
}
```

### Step 4 — Token budget guard

`buildFileContext()` should apply the same `MAX_CONTEXT_TOKENS` cap already used in `assemblePrompt()`. Extract the truncation logic so it runs before the string is sent, not after:

```ts
private truncateToTokenBudget(text: string, budget: number): string {
    const tokens = estimateTokens(text);
    if (tokens <= budget) return text;
    return text.slice(0, budget * 4) + '\n[…truncated]';
}
```

Use `MAX_CONTEXT_TOKENS = 6_000` (same constant as offline path).

---

## Part 5 — What Does NOT Change

- `assemblePrompt()` in the offline path — still used as-is.
- `runGuard()` — not called in gateway path (backend owns the guard).
- `TutorChatResponse` wire type — `file_context` is request-only; the response shape is unchanged.
- Token budget constants — reuse existing values, do not introduce new ones.

---

## Part 6 — Testing Checklist

- [ ] Unit: `buildFileContext()` returns empty string when `file_scan` finds nothing.
- [ ] Unit: `buildFileContext()` truncates when file contents exceed budget.
- [ ] Unit: `TutorChatGateway.send()` omits `file_context` from POST body when undefined.
- [ ] Unit: `TutorChatGateway.send()` includes `file_context` in POST body when provided.
- [ ] Integration (manual): start the backend, ask "explain my hw11.R" — verify the LLM response references actual code content.
- [ ] Regression: offline path still works unchanged (no `tutorChatGateway` injected).
