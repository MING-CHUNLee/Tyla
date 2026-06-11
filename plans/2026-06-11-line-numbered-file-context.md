# Plan: Line-numbered file_context + @file 顯式載入

日期：2026-06-11（決策定案：2026-06-11）
範圍：MindyCLI_demo（前端 CLI）+ Tyla-api（後端 prompt / tool schema）

## 已定案決策（2026-06-11 討論結果）

1. **file_scan 保留 name-only 清單**，只 gating「內容讀取」（@ 才讀內容）。
2. **只有 `search` 帶行號**；`replace` 為純程式碼不帶行號（前端仍防禦性 strip）。
3. **移除 `PER_FILE_TOKEN_CAP = 1200` 的單檔上限** —— @-gating 後只載學生點名
   的檔案，不需再防「自動載入的無關檔吃掉池子」。`FileContextBudget` 仍保留
   per-turn 池作為後端 context_overflow 的最後防線（B3 continuation loads 也從
   同一池扣），單檔可吃滿整個池子。
4. **TUI 偵測 prompt 無 `@` 時顯示一條 info 提示**（提示可用 `@檔名` 指定檔案）。
   偵測與顯示放在 presentation 層（TUI），不進 use case。
5. **per-turn cap 保留並放寬**（2026-06-11 追加討論）：`ContinuationFileLoader`
   沒有其他大小防線（不走 FileReadService 的 100k 上限），且 B3 `load_file` 是
   LLM 自發的、不受使用者控制，所以池子不能拿掉。`PER_TURN_FILE_CONTEXT_TOKEN_CAP`
   從 2,200 放寬至 **4,000–6,000（或做成可設定）**，目標是學生點名的檔案幾乎
   不被截斷，數值於 Phase 0 量測後定案（§2.7 的後端 warning 是它的 safety net）。
6. **後端 drop 不再沉默 —— response 加 `warnings` 欄位**（2026-06-11 追加討論）：
   `BudgetAwarePromptAssembler` 在 file_context 塞不下時整塊 drop 並設
   `student_file_dropped: true`，但 `run_tutor_chat.rb` 組 DTO 時沒有使用該 flag
   —— LLM 看不到檔案、學生也不知道。改為後端回傳 warnings、CLI 轉成
   `status_update` warning 顯示給學生（詳見 §2.7）。

**驗證流程**：實作完成後必須先 `cd tyla && bun run test` 全綠，再 `bun run build`
確認 TypeScript 編譯通過，才算完成。

## 0. 目標（DEV）

> Front-end adds/strips line numbers to each line of file it sends; backend informs
> LLM that there are line numbers it should preserve in its response.

兩個子目標：

1. **@file 顯式載入**：`buildFileContext()` 不再無條件 `file_scan` + 自動讀檔
   （substring 比對 + fallback top-5）。改為只有使用者 prompt 內含 `@<file>` 時
   才讀該檔內容進 `file_context`。
2. **行號標記**：前端送出的檔案內容每行加上行號前綴；後端 prompt + tool schema
   告知 LLM `edit_file.patches[].search` 必須帶行號；前端套用 patch 時利用行號
   定位、並把行號剝除後寫回真實檔案。解決多行 `search` 找錯位置／撞到重複片段
   的問題。

## 1. 現況（涉及的程式碼）

### CLI — `tyla/src/application/use-cases/execute-tutor-use-case.ts`
- `buildFileContext()` (L294)：每回合無條件 `file_scan` → `readRelevantFiles()`
  （檔名 substring / 副檔名比對）→ 沒命中就 `readFallbackFiles()`（top-5 source files）。
- 所有內容讀取走 `ContinuationFileLoader.resolve()`（confinement / PDF / binary /
  `FileContextBudget` 都在裡面），block 格式為 `### <label>\n<body>\n\n`。
- `dispatchEditFile()` (L236)：`applyPatches()` 用 `String.includes` + 第一次出現
  替換 —— 這就是 search 多行 / 重複片段會套錯的根因。

### API — Tyla-api
- `app/application/services/tutor_chat/run_tutor_chat.rb` — `TOOLS` 常數：
  `edit_file.search` 描述為 "Exact snippet to find (must be unambiguous)"。
- `app/application/prompts/builders/tutor_system_prompt.rb` — `live_context`
  渲染為 `## Student Workspace (live)`；`TOOL_USE_GUIDE` 描述何時呼叫工具。

## 2. 設計決策

### 2.1 行號格式（前後端共同約定）

```
  1| library(ggplot2)
  2| d123 <- rnorm(100)
  3| quantile(d123, probs = c(0.25, 0.75))
```

- 格式：`<right-aligned line number>| <code>`，剝除 regex：`/^\s*\d+\| ?/`。
- 選 `|` 而非 tab/`→`：肉眼可讀、LLM 抄寫穩定；R 的 `|>` / `|` 不會出現在
  行首接在數字後，誤剝風險可忽略。
- **行號必須對應真實檔案行號**（不是 block 內的相對行號），前端才能用它定位。
  `FileContextBudget.take()` 的截斷是「保留開頭」，所以截斷後行號仍然正確。

### 2.2 search 帶行號、replace 不帶行號（與原始敘述的差異，需確認）

原始 DEV 寫的是「LLM 在 response 中 preserve line numbers」。這裡建議精確化為：

- `search`：**必須**逐字包含行號前綴（這是定位 key）。
- `replace`：**不得**包含行號 —— 替換後行數可能增減，replace 裡的行號必然失效，
  反而會被誤寫進檔案。前端仍防禦性地對 replace 也跑一次 strip。
- prose（給學生看的說明文字）引用程式碼時不帶行號 —— 否則學生會看到 `3| ...`。

### 2.3 套用策略：行號錨定優先，文字搜尋 fallback（兩層）

`dispatchEditFile()` 改為：

1. **Anchored apply**：解析 `search` 每行的行號前綴。若行號連續，取原檔
   `lines[n..m]`，與剝號後的 search 內容比對（trimEnd 寬鬆比對，容忍行尾空白）。
   吻合 → 直接 splice 換成剝號後的 replace 行。重複片段問題在此徹底解決。
2. **Fallback**：行號缺失或驗證不吻合（例如使用者在兩回合之間改了檔案 → 行號
   過期）→ strip 行號後退回現行 `includes` 第一次出現替換，並 emit
   `status_update` warning 註明 fallback 原因。兩層都失敗才 skip-and-warn（現行為）。

多個 patch 的行號都錨定在「原始檔案」行號上；若 patch 改變行數，後面的 anchor 會
位移 → **依 start line 由大到小套用**（bottom-up），前面的錨點即不受影響。

> 驗證步驟同時是 stale-context 保護：使用者在送出 prompt 前自己改過檔案時，
> 行號錨定會 mismatch 而安全退回文字搜尋，不會盲目照行號蓋掉新內容。

### 2.4 @file 顯式載入

- 從 instruction 解析 `@<token>`：regex `/@([\w\-./\\]+)/g`（路徑字元集；之後若要
  支援含空白檔名再加 `@"..."` 形式）。
- token 對 `file_scan` 結果比對（basename 不分大小寫）；比對不到時直接把 token
  當相對路徑丟給 `loader.resolve()`（confinement 會擋逃逸），失敗則 block 內含
  unavailable marker + emit warning —— LLM 與使用者都看得到。
- **刪除** `readRelevantFiles()` 的 substring / 副檔名比對與
  `readFallbackFiles()`（含 `FALLBACK_FILE_LIMIT` / `FALLBACK_GROUPS` /
  `PER_FILE_TOKEN_CAP` 常數）。
- `FileContextBudget`：**移除單檔上限**（決策 3）—— 只載學生點名的檔案，單檔可
  吃滿池子。**保留 per-turn 池並放寬**（決策 5）：
  `PER_TURN_FILE_CONTEXT_TOKEN_CAP` 2,200 → 4,000–6,000（或可設定），@ 載入
  與 B3 continuation loads 仍從同一池扣。實作上 `FileContextBudget` 建構子改為
  只收 per-turn cap（或 perFileCap 預設 = perTurnCap），`take()` 截斷邏輯不變。
  前端截斷（graceful degradation：LLM 至少看到檔案開頭 + truncated 標記、行號
  仍正確）與後端 warning（§2.7，safety net）分層並存。

### 2.5 file_scan 的去留（已定案：決策 1）

`file_scan` 有兩個產出：`## Project Context`（name-only 檔案清單）與讀檔用的
路徑表。**保留 name-only 清單每回合都送**（很便宜），只把「讀內容」改成
@-gated，理由：

- B3 `load_file` 迴圈靠這份清單才知道 workspace 有什麼檔可以要；拿掉後 LLM 只能
  瞎猜路徑，continuation 會浪費在猜檔名上。
- Tool Use Guide 寫著 "Call `load_file` when you need to see a workspace file
  not provided in context" —— 沒有清單這句話形同虛設。

### 2.6 無 @ 時的 TUI 提示（已定案：決策 4）

prompt 內偵測不到 `@` token 時，TUI 顯示一條 info：
`提示：可用 @檔名（如 @hw2.R）將檔案內容帶給 tutor`。

- 偵測與顯示都在 **presentation 層**（送出前檢查輸入字串即可，正規表示式與
  `line-numbering` / @-parsing 共用同一條 `/@([\w\-./\\]+)/` 約定）。
- 不進 use case、不發 event —— 這是輸入 UX 提示，不是 pipeline 狀態。
- 只在 tutor 模式顯示；可考慮同 session 只提示一次避免洗版（實作時決定）。

### 2.7 後端 drop 警告：response `warnings` 欄位（已定案：決策 6）

現況：`budget_aware_prompt_assembler.rb` 在 live `file_context` 超出剩餘預算時
**整塊 drop**（`workspace_dropped = true`，L65），flag 透過 result 的
`student_file_dropped` / `history_turns_dropped` 回傳，但 `run_tutor_chat.rb`
的 `ok_outcome` 組 DTO 時並未使用 —— 沉默丟棄，LLM 看不到檔案、學生也不知道。

改法（把既有資訊接出去，不改 trimming 邏輯）：

- **後端**：`Response::TutorChat` DTO 加選填 `warnings: string[]` 欄位，值域
  `["file_context_dropped", "history_truncated"]`；representer 僅在非空時輸出
  （既有 client 不受影響）。`ok_outcome` 從 assembler result 把
  `student_file_dropped` / `history_turns_dropped > 0` 對應填入。
- **CLI**：`tutor-chat-gateway` 解析 response 的 `warnings`（缺省為 `[]`，向後
  相容舊後端）；`execute-tutor-use-case` 對應 emit `status_update` warning：
  - `file_context_dropped` → 「檔案內容超過後端預算，本回合 tutor 沒有看到你的檔案」
  - `history_truncated` → 「對話歷史過長，較早的回合已被省略」
- **分層定位**：這是 safety net，不是主要防線 —— drop 發生時這一輪 LLM 仍然
  完全沒看到檔案，回答品質是壞的；主要防線是前端 per-turn 截斷（§2.4），讓
  超量回合至少保有檔案開頭可用。warning 解決的是「不知道」，不是「看不到」。

## 3. 變更清單

### 3.1 CLI（tyla/）

**NEW `src/application/services/line-numbering.ts`** — add/strip 對稱放同一模組：
```ts
export function addLineNumbers(text: string): string;          // '  1| ...'
export function stripLineNumberPrefixes(text: string): string; // 防禦性剝除
export interface AnchoredLine { lineNo: number; text: string }
export function parseNumberedLines(s: string): AnchoredLine[] | null; // 全行有號且連續才回傳
```

**`src/application/services/continuation-file-loader.ts`**
- 文字檔：`budget.take(label, addLineNumbers(text))`。
- **PDF 摘錄不加行號**（沒有可錨定的「檔案行」，徒增 token）。
- 註：行號使 token 增 ~10–15%，budget 在 take 時量的是加號後內容，帳是準的，
  但等效可載入行數變少（見 §6 討論點 3）。

**`src/application/use-cases/execute-tutor-use-case.ts`**
- `buildFileContext()`：`readRelevantFiles` → `readMentionedFiles(instruction, …)`
  （@ 解析）；刪 `readFallbackFiles`。沒有 @ 時 `## File Contents` 區塊省略，
  只送 Project Context（LLM 需要檔案內容時走 `load_file`，行號由 loader 統一加）。
- `dispatchEditFile()`：`applyPatches` → 新的 `applyNumberedPatches`
  （§2.3 兩層策略；bottom-up 排序）。純函式，放檔案頂部 helpers 區。
- `PER_TURN_FILE_CONTEXT_TOKEN_CAP`：2,200 → 4,000–6,000 或可設定（決策 5，
  Phase 0 量測定案）。
- 解析 gateway 回傳的 `warnings`，emit 對應 `status_update` warning（§2.7）。

**`src/infrastructure/api/tutor/tutor-chat-gateway.ts`**
- response 解析加選填 `warnings: string[]`（缺省 `[]`，向後相容無此欄位的舊後端），
  透傳給 use case。

**TUI（presentation 層）**
- 送出 tutor prompt 前偵測無 `@` → 顯示 info 提示（§2.6）。改動點在 tutor 模式
  的輸入處理元件（實作時定位確切檔案）。

**測試（`tyla/tests/unit/...`）**
- NEW `line-numbering.test.ts` — add/strip roundtrip、CRLF、空檔、行號連續性解析。
- `execute-tutor-use-case.test.ts`
  - §C budget 三條測試以 fallback 自動載入觸發 → 改為 @-mention 觸發；
    「caps a single oversized base file to the per-file budget」隨單檔上限移除
    改寫為「單檔可吃滿 per-turn 池、超過 per-turn 池才截斷」。
  - 新增：`@hw2.R` 載入、@ 指向不存在檔案 → marker + warning、無 @ → 無 File
    Contents 區塊、edit_file 行號錨定命中／行號過期 fallback／重複片段選對位置、
    bottom-up 多 patch、response 帶 `warnings` → emit 對應 status_update。
- `tutor-chat-gateway.test.ts`：`warnings` 解析（有值／缺欄位 → `[]`）。
- `tutor-chat-gateway` cassettes：若 cassette 內含 file_context 字串需同步重錄。

### 3.2 API（Tyla-api/）

**`app/application/services/tutor_chat/run_tutor_chat.rb`** — `TOOLS.edit_file`：
- description 追加：workspace 檔案內容每行帶 `N| ` 行號前綴。
- `search.description` → "Exact lines to find, copied verbatim INCLUDING the
  leading `N| ` line-number prefixes shown in the workspace context."
- `replace.description` → "Replacement code WITHOUT line-number prefixes."

（tool schema 的 description 是 tool_use 模型遵循度最高的位置，比 system prompt
更 load-bearing，兩邊都要寫。）

**`app/application/prompts/builders/tutor_system_prompt.rb`**
- 新增 `LINE_NUMBER_GUIDE` 常數，**只在 `live_context` 分支 append**（fixture
  `context_files` 沒有行號，無條件加會教壞模型）：
  ```
  ## Workspace Line Numbers
  Every line in the live workspace files is prefixed with its line number ("12| ").
  - In edit_file `search`, copy the lines verbatim INCLUDING the number prefixes.
  - In edit_file `replace`, write plain code WITHOUT number prefixes.
  - When quoting code in your explanation to the student, omit the prefixes.
  ```

**`Response::TutorChat` DTO + representer（§2.7，決策 6）**
- DTO 加選填 `warnings: string[]`（`["file_context_dropped", "history_truncated"]`），
  representer 僅在非空時輸出。
- `run_tutor_chat.rb` 的 `ok_outcome` 接收 assembler result，從
  `student_file_dropped` / `history_turns_dropped > 0` 填入 warnings
  （需把 assembled result 傳進 `ok_outcome`，目前簽名只有 `log, reply, verdict`）。

**specs**
- `tutor_system_prompt_spec.rb`：live_context 有 guide / fixture 路徑沒有 guide。
- `run_tutor_chat_spec.rb`：schema description 變更若有 snapshot 需更新；
  warnings 填入（dropped → 有值；正常 → 欄位不出現）。
- representer spec：warnings 空陣列時不輸出欄位。

**`doc/api_tutor_chats.md`** — 記錄 `file_context` 行號約定與 `warnings` 欄位
（前後端 contract）。

## 4. 實作順序

1. CLI `line-numbering.ts` + 單元測試（無依賴，先落地約定）。
2. CLI loader 加行號 + `applyNumberedPatches`（此時即使後端 prompt 未更新，
   strip fallback 保證行為不退化 —— LLM 不帶行號照舊走文字搜尋）。
3. CLI @-gating（含移除單檔上限、放寬 per-turn cap）+ 測試改寫。
4. CLI gateway `warnings` 解析 + use case emit（§2.7；舊後端缺欄位 → `[]`，
   先上也相容）。
5. TUI 無 @ 提示（§2.6）。
6. **驗證：`cd tyla && bun run test` 全綠 → `bun run build` 編譯通過**（每個
   CLI 步驟完成後都跑 test；build 在 CLI 端全部完成後執行）。
7. API tool schema + system prompt + specs（部署後 LLM 才開始回帶行號的 search，
   anchored path 生效）。
8. API `warnings` 欄位（DTO + representer + `ok_outcome`）+ specs。
9. 手動 E2E：對含重複 `quantile(...)` 片段的 hw 檔下修改指令，確認 patch 落在
   行號指到的那一處；另以超大檔驗證 truncated 標記與 `file_context_dropped`
   warning 各自出現在正確層。

順序 2→8 刻意讓**前端先相容、後端再啟用**，中間任何時點都可部署。

## 5. 不變 / 明確排除

- `execute-instruction-use-case`（非 tutor edit pipeline）與 ask pipeline 不動。
- TUI 的 `@` 自動補全是 UX 加分項，另開 task。
- `MAX_CONTINUATIONS` / guard 流程不動。

## 6. 討論點決議（2026-06-11，原開放問題已全部定案）

1. **file_scan 去留** → 保留 name-only 清單、只 gating 內容讀取（§2.5）。
2. **replace 行號** → 只有 `search` 帶行號，`replace` 純程式碼（§2.2）。
3. **Budget 上限** → 移除 `PER_FILE_TOKEN_CAP` 單檔上限；只載學生點名的檔案，
   單檔可吃滿池子。per-turn 池保留作為後端 `context_overflow` 最後防線（§2.4）。
4. **無 @ 提示** → 採用，放在 TUI（presentation 層），不進 use case（§2.6）。
5. **per-turn cap 是否也移除？** → 不移除，保留並放寬至 4,000–6,000／可設定
   （§2.4；理由：loader 無其他大小防線、B3 load_file 不受使用者控制、後端
   超量行為是 whole-or-drop 比前端截斷更糟）。
6. **後端沉默 drop** → response 加選填 `warnings` 欄位、CLI 轉 `status_update`
   warning（§2.7）。與前端截斷分層並存：截斷是主要防線（graceful degradation），
   warning 是 safety net（解決「不知道」，不是「看不到」）。
