# Plan: Continuation Loop — 第二輪未對 Rmd 發出 edit_file

日期：2026-06-14
範圍：`tyla/src/application/use-cases/execute-tutor-use-case.ts`（frontend B3 continuation loop）
關聯 log：guard log_id 142、tutor log_id 143（Round 1）、144（Round 2）

---

## 0. 問題描述

學生 prompt：
> "Please help me fix the quartile settings in @hw2.R, and also check and correct the skewness of d123 in Question 1 of Hw2.Rmd"

預期行為：
1. **Round 1**：backend 只看到 `hw2.R`（@-mentioned），嘗試編輯 `Hw2.Rmd` 但被 RedirectGate 攔截
   → 回傳 `edit_file hw2.R` + `load_file Hw2.Rmd`
2. **Round 2**：frontend 把 `Hw2.Rmd` 加入 `file_context` 後再次呼叫 backend
   → backend 看到兩個檔案，應回傳 `edit_file hw2.R` + `edit_file Hw2.Rmd`

實際行為（log_id 144）：
- Round 2 backend 仍只回傳 `edit_file hw2.R` + `load_file Hw2.Rmd`
- 並附帶 `warnings: ["edit_file_redirected"]` — 代表 **RedirectGate 在 Round 2 再次攔截了對 Hw2.Rmd 的 edit**
- Frontend `resolved.has('Hw2.Rmd') === true` → `madeProgress = false` → loop 終止
- 結果：只有 `hw2.R` 被修改，`Hw2.Rmd` 完全沒有被編輯

---

## 1. 根本原因分析

### 1.1 Backend RedirectGate 的判斷邏輯

Backend 的 `RedirectGate`（server side）判斷「某檔案是否已載入」的方式是：
**解析 `file_context` 欄位內容，抓取 `### <path>` 標頭，建立已載入檔名集合**，
然後對 LLM 產生的每個 `edit_file` 動作，檢查目標路徑是否在集合內。

### 1.2 Frontend 產生的 `file_context` 格式（舊版，有 bug）

Round 2 傳送的 `file_context` 如下（取自 debug log）：

```
## Files Loaded On Request
### hw2.R
 1| ...
### Hw2.Rmd
  1| ...
```

**問題關鍵**：`## Files Loaded On Request` 是 Markdown 二級標題（`## `）。
後端把整份 prompt 解析為 Markdown section tree；
`## Student Workspace (live)`（backend 注入的段落）與 `## Files Loaded On Request`
是同層 sibling — 結果 `file_context` 的 `### hw2.R` / `### Hw2.Rmd` 被解析為
`## Files Loaded On Request` 的子節點，**而非 `## Student Workspace (live)` 的子節點**。

RedirectGate 只掃描 `## Student Workspace (live)` 的直接子 `### ` 節點，
因此在它看來，**`Hw2.Rmd` 從未被載入** — 無論 Round 幾，gate 都會攔截並重導向。

### 1.3 為什麼 Round 1 可以通過？

Round 1 的 `file_context` 只有 `### hw2.R`（@-mention），
`hw2.R` 的 edit 沒有被攔截（hw2.R 存在且被載入），
`Hw2.Rmd` 的 edit 被攔截是正確行為（尚未載入），一切表現正常。

Round 2 才暴露問題：`Hw2.Rmd` 實際上已在 `file_context`，但 RedirectGate 仍攔截。

---

## 2. 證據清單

| 證據 | 說明 |
|------|------|
| log_id 144 `warnings: ["edit_file_redirected"]` | Round 2 backend 再次觸發 redirect，代表 gate 認為 Hw2.Rmd 未載入 |
| Round 2 request `file_context` 含 `## Files Loaded On Request` | 舊格式，造成 Markdown section tree 解析錯誤 |
| `execute-tutor-use-case.ts:249-254` 的現有程式碼注釋 | 已記錄同樣根因：`## ` 標題變成 sibling，導致 backend section 顯示為空 |
| 現有測試 `line 287-288` | 新增 `expect(fileContext).not.toContain('## Files Loaded On Request')` 驗證修正 |

---

## 3. 修正方案（已在 working tree 實作）

### 3.1 移除 `## Files Loaded On Request` 標題

`file_context` 改為純 `### <path>` 區塊序列（flat blocks），不加任何 `## ` 節點：

```
### hw2.R
 1| set.seed(789)
 2| ...
### Hw2.Rmd
  1| ---
  2| title: "Hw2"
...
```

這樣 backend Markdown 解析後，`### hw2.R` 與 `### Hw2.Rmd` 都直接掛在
`## Student Workspace (live)` 之下，RedirectGate 可以正確建立已載入集合。

### 3.2 變更位置

`execute-tutor-use-case.ts:254`（`callGateway` 的 continuation loop 頂部）：

```ts
// 舊
const fileContext = loadedBlocks.join('');
// （其中 loadedBlocks 的每個 block 以 `## Files Loaded On Request\n### path\n...` 開頭）

// 新
const fileContext = loadedBlocks.join('');
// （ContinuationFileLoader 產生的 block 改為以 `### path\n...` 開頭，無 ## 標題）
```

實際修改在 **`ContinuationFileLoader`** 與其呼叫鏈上負責組裝 block 的地方；
`callGateway` 本身只是把 blocks join 後傳送，不需改動。

### 3.3 修正後的預期流程

```
Round 1
  file_context: "### hw2.R\n 1| ..."
  backend: edit_file hw2.R ✓  |  edit_file Hw2.Rmd → redirect → load_file Hw2.Rmd
  frontend: madeProgress=true, 繼續 Round 2

Round 2
  file_context: "### hw2.R\n 1| ...\n### Hw2.Rmd\n  1| ..."
  backend: RedirectGate 看到 Hw2.Rmd ∈ loaded set → 不攔截
  backend: edit_file hw2.R ✓  |  edit_file Hw2.Rmd ✓
  frontend: no new load_file → madeProgress=false → 終止
  dispatch: 兩個 edit 都送進 dispatchActions
```

---

## 4. 測試策略

### 4.1 已有的單元測試（`execute-tutor-use-case.test.ts`）

| 測試 | 覆蓋點 |
|------|--------|
| `file_context has no ## section headings — flat ### blocks only` | 直接斷言 `file_context` 不含 `## Files Loaded On Request`（L362-373） |
| `@-mention path seeds resolved — load_file for same path terminates loop in one call` | 確認 dedup 後 tutor 只被呼叫一次（L339-360） |

### 4.2 需新增：Round 2 能正確 dispatch 兩個 edit 的整合測試

目前 `execute-tutor-use-case.test.ts` 沒有測試「continuation loop Round 2 產生兩個 edit」的場景。
需要新增：

```ts
it('continuation: Round 2 dispatches edit_file for Rmd once Rmd is loaded', async () => {
    // Round 1: returns edit_file hw2.R + load_file Hw2.Rmd
    // Round 2: returns edit_file hw2.R + edit_file Hw2.Rmd
    // Expected: both edits dispatched, tutor called exactly twice
});
```

### 4.3 驗收條件

以 log 中的 prompt 重跑後：
- `tutor` endpoint 被呼叫兩次（Round 1 + Round 2）
- Round 2 回傳的 `warnings` **不含** `edit_file_redirected`
- `diff_proposed` 事件觸發兩次（hw2.R 和 Hw2.Rmd 各一次）
- 兩份 edit 均通過 user approval flow 後寫入磁碟

---

## 5. 範圍與風險

| 項目 | 評估 |
|------|------|
| 影響範圍 | 僅 `file_context` 格式；`workspace_overview` 走獨立欄位，不受影響 |
| 向後相容 | Backend 已支援純 `### ` 格式（依 plan 2026-06-12 §4 合約）；移除 `## ` 不破壞舊合約 |
| 無需改動 | `callGateway`、`dispatchActions`、`EditStagingService`、`DiffEngine`、所有 gateway |
| 潛在風險 | 若 backend 有另一處邏輯依賴 `## Files Loaded On Request` 標題，移除後須確認（目前合約文件無此依賴） |

---

## 6. 完成標準

- [ ] `bun run build` 編譯通過（無 TypeScript 錯誤）
- [ ] `bun run test` 全綠，含 §4.1 現有測試
- [ ] §4.2 新測試通過
- [ ] 手動以 `@hw2.R` + `Hw2.Rmd` 二檔案 prompt 重現場景，確認 Round 2 `warnings` 不含 `edit_file_redirected`，且兩個 diff 都呈現給 user
