# 【Agentic Tutor】Proposal: A Practical Middle Ground

> Revised wording for the final DISCUSS slide. Copy/paste back into the deck.
> **Core message:** the tutor can now *act*, but every file change still passes through diff + human approval.

---

## 1. Change the API format

**Request (TUI → API)** — `POST /api/v1/tutor_chats`
Headers: `X-LLM-Key` / `X-LLM-Provider` / `X-LLM-Model` / `X-LLM-Endpoint`

```json
{
  "course_id":  "CS101",
  "project_id": "proj-1",
  "student_id": "stu-abc",
  "prompt":     "Why is the Freedman-Diaconis rule least sensitive to outliers?",
  "history": [
    { "role": "user",      "content": "What are Sturges, Scott, and FD?" },
    { "role": "assistant", "content": "Hint 1: ..." }
  ],
  "file_context": "## Project Context ...\n## File Contents ..."   // optional
}
```

**Response (API → TUI)**

```json
{
  "log_id":  101,
  "status":  "done",
  "content": "Step 1: ...\nHint 1: ...",
  "actions": [
    {
      "type": "edit_file",
      "path": "hw11.R",
      "patches": [
        { "search": "mean(x)", "replace": "mean(x, na.rm=TRUE)" }
      ]
    }
  ],
  "usage": { "input_tokens": 4321, "output_tokens": 512 }
}
```

The response now carries **text for the student (`content`) and structured actions for the machine (`actions`)** side by side.

---

## 2. Execute actions via ReAct

The ReAct loop runs each tool based on the actions in the response — reusing **Pattern A**, but the trigger is now the backend's `actions` array instead of inline `[ACTION]` markers.

---

## 3. Gate edits behind approval

For any file edit, reuse **Pattern B**:

```
generate diff → preview change → wait for human approval → write file
```

The LLM never writes to disk directly.

---

### One-line takeaway

> The tutor can now act — but every file change still passes through diff + human approval.
> *(Teachers won't do the homework for you; the tutor won't silently edit your file.)*
