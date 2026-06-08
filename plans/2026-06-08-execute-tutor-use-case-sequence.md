# ExecuteTutorUseCase — Sequence Diagram

> 示例情境：學生詢問 hw2.R 分位數錯誤，Guard 放行後 Tutor 回傳 edit_file 動作，學生核准後寫入磁碟。

```mermaid
sequenceDiagram
    actor Student
    participant UC as ExecuteTutorUseCase
    participant FS as Local Filesystem
    participant Guard as Guard API
    participant Tutor as Tutor API

    Student->>UC: execute(instruction, history=[])

    rect rgb(255, 255, 204)
        Note over Student,Tutor: 1 - Build File Context (file_scan + file_read)
        UC->>FS: file_scan(directory: Hw2/)
        FS-->>UC: hw2.R, Hw2.Rmd, Hw2.Rproj, Hw2.pdf (4 files)
        Note right of UC: instruction names hw2.R → matched, reading it
        UC->>FS: file_read(hw2.R) capped at 1200 tok
        FS-->>UC: hw2.R content
        Note right of UC: fileContext = ProjectContext + FileContents
    end

    rect rgb(255, 255, 204)
        Note over Student,Tutor: 2 - Guard Pre-call
        UC->>Guard: check(instruction)
        Note right of UC: course_id, project_id, student_id, prompt
        Guard-->>UC: status=done, log_id=67, refusal=null
        Note right of Guard: 1754 input tok / 27 output tok
    end

    rect rgb(255, 255, 204)
        Note over Student,Tutor: 3 - B3 Continuation Loop (MAX_CONTINUATIONS=3)
        loop i=0 until madeProgress=false or MAX reached
            UC->>Tutor: send(instruction, history=[], guard_log_id=67, fileContext)
            Tutor-->>UC: status=done, actions=[edit_file hw2.R], content=
            Note right of Tutor: 4673 input tok / 69 output tok
            alt new load_file action found and i < MAX_CONTINUATIONS
                UC->>FS: ContinuationFileLoader.resolve(requested path)
                FS-->>UC: file block appended to loadedBlocks
                Note right of UC: madeProgress=true → continue loop (emit continuation)
            else no load_file actions (terminal turn)
                Note right of UC: madeProgress=false → exit loop
            end
        end
    end

    rect rgb(255, 255, 204)
        Note over Student,Tutor: 4 - Dispatch Actions (edit_file hw2.R)
        UC->>FS: read hw2.R original
        FS-->>UC: original content with quantile(d123, probs = c(0.25, 0.75))
        Note right of UC: applyPatches — search c(0.25, 0.75) replace c(0.1, 0.5, 0.9)
        UC-->>Student: diff_proposed (path, diff, diffLines, original, proposed)
        Student-->>UC: onApproval callback
        alt Student approves
            UC->>FS: stagingService.applyEdit — write hw2.R proposed content
            UC-->>Student: edit_applied event
        else Student rejects
            UC-->>Student: edit_rejected event
        end
    end

    UC-->>Student: TutorResult(content, usage)
```

## 流程說明

### Phase 0 — Gateway Guard（程式碼 L125–129）
呼叫前先確認 `guardCheckGateway` 和 `tutorChatGateway` 都已注入，否則拋出 friendly error，不走進後續流程。

### Phase 1 — Build File Context（L134–135, L305–321）
- `file_scan` 掃描工作目錄，回傳分類檔案清單
- `readRelevantFiles()` 比對 instruction 中提到的檔名（case-insensitive）
- 若無命中，`readFallbackFiles()` 自動讀取最多 5 個 rScripts/rMarkdown
- 每個檔案受 `PER_FILE_TOKEN_CAP=1200 tok` 限制，整批受 `PER_TURN_FILE_CONTEXT_TOKEN_CAP=2200 tok` 限制

### Phase 2 — Guard Pre-call（L138–159）
- `guardCheckGateway.check(instruction)` → 取得 `log_id`
- `status=forbidden` → 直接回傳 refusal，不呼叫 Tutor
- `status=error` → emit error，不呼叫 Tutor

### Phase 3 — B3 Continuation Loop（L162–222）
- 每次迭代用 `tutorChatGateway.send()` 傳入 `guard_log_id` + `fileContext`
- 若 response 含 `load_file` action → `ContinuationFileLoader.resolve()` 載入檔案，`madeProgress=true`，繼續迴圈
- 無新 `load_file` 或達到 `MAX_CONTINUATIONS=3` → terminal turn，進入 Phase 4

### Phase 4 — Dispatch Actions（L232–288）
- `edit_file`：讀原始檔 → `applyPatches()` → `stageOnly()` → `diff_proposed` event → `onApproval` → 寫入或拒絕
- `execute_script`：`script_proposed` event → `onApproval` → 呼叫 `r_exec` tool

> `load_file` action 在 Phase 3 被 driver 消耗，不會進入 dispatchActions。
