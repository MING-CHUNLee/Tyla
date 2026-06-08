# ExecuteTutorUseCase 循序圖
**Prompt:** `Please explain what I need to submit based on the assignment PDF`
**Date:** 2026-06-08 | **Log IDs:** guard=97, tutor=98

---

## 流程說明

此 prompt 屬於純問答型（no `load_file` / `edit_file` / `execute_script` actions），走完一次 B3 continuation loop 即終止。

### 關鍵決策點

| 步驟 | 決策 | 結果 |
|------|------|------|
| `readRelevantFiles` | instruction 含 `"pdf"` → extension match | 讀取 `Hw2.pdf` |
| Guard response | `status=done`, `refusal=null` | 繼續呼叫 tutor |
| Tutor response (i=0) | `actions=[]` → 無 `load_file` | `madeProgress=false` → terminal turn |
| `dispatchActions` | `actions` 過濾掉 `load_file` 後為空 | 不觸發 approval gate |

---

## Mermaid 循序圖

```mermaid
sequenceDiagram
    actor Student
    participant UC as ExecuteTutorUseCase
    participant Tool as ToolRegistry
    participant Loader as ContinuationFileLoader
    participant FS as Local Filesystem
    participant Guard as GuardCheckGateway
    participant Tutor as TutorChatGateway

    Student->>UC: execute(prompt, history=[])

    rect rgb(255, 255, 204)
        Note over Student,Tutor: 1 - Build File Context (scan phase)

        UC->>Tool: file_scan(directory=CSDS/Hw2)
        Tool->>FS: scan workspace
        FS-->>Tool: hw2.R, Hw2.Rmd, Hw2.Rproj, Hw2.pdf
        Tool-->>UC: projectContext + scannedFiles[4]

        Note right of UC: instruction contains ext=pdf<br/>readRelevantFiles → match Hw2.pdf

        UC->>Loader: resolve(directory, Hw2.pdf, budget)
        Note right of Loader: PathConfinement check pass
        Loader->>FS: extractPdfText(Hw2.pdf)
        FS-->>Loader: PDF text (7 pages)
        Loader-->>UC: block capped at 1200 tokens

        Note right of UC: baseContext = Project Context + File Contents(Hw2.pdf)<br/>rScripts/rMarkdown: NOT auto-loaded (explicit match wins)
    end

    rect rgb(220, 235, 255)
        Note over Student,Tutor: 2 - Guard Pre-call

        UC->>Guard: check(prompt)
        Note right of Guard: input_tokens=1704 / output_tokens=25
        Guard-->>UC: status=done, logId=97, refusal=null

        Note right of UC: guard passed → proceed to tutor loop
    end

    rect rgb(220, 255, 220)
        Note over Student,Tutor: 3 - B3 Continuation Loop (i=0)

        Note right of UC: loadedBlocks=[] → fileContext = baseContext only

        UC->>Tutor: send(prompt, history=[], guardLogId=97, fileContext)
        Note right of Tutor: input_tokens=6203 / output_tokens=1193 / log_id=98

        Tutor-->>UC: status=done, content=[detailed explanation], actions=[]

        Note right of UC: loads = actions.filter(load_file) = []<br/>madeProgress = false → exit loop (terminal turn)

        UC->>Student: emit text_output(content)
        UC->>Student: emit phase_end(tutor, success=true)

        Note right of UC: dispatchActions([]) → nothing to dispatch<br/>No approval gate triggered
    end

    UC-->>Student: TutorResult { content, usage: {in:6203+1704, out:1193+25} }
```

---

## 各阶段 token 統計

| Phase | input_tokens | output_tokens |
|-------|-------------|--------------|
| Guard | 1,704 | 25 |
| Tutor (turn 0) | 6,203 | 1,193 |
| **Total** | **7,907** | **1,218** |

---

## 程式碼對照（execute-tutor-use-case.ts）

| 圖中步驟 | 對應程式碼 | 行號 |
|---------|-----------|------|
| Build File Context | `buildFileContext()` → `buildProjectContext()` → `readRelevantFiles()` | L305–L321 |
| extension match | `ext.length > 0 && instructionLower.includes(ext)` | L384 |
| extractPdfText | `ContinuationFileLoader.resolve()` calls `extractPdfText` | L110 |
| Guard pre-call | `guardCheckGateway.check(instruction)` | L141 |
| Tutor loop | `for (let i = 0; ; i++)` | L166 |
| No load_file → terminal | `madeProgress = false` → skip `continue` | L212–L215 |
| dispatchActions | 過濾 `load_file` 後呼叫 `dispatchActions` | L220 |
