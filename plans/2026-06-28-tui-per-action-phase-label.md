# 前端：dispatch action 時顯示「實際 agentic work」逐項標籤

**Date:** 2026-06-28
**Status:** ✅ 已完成（2026-06-28 實作 + 驗證）
**範圍：** 純前端（use case 事件文案），不動後端、不動事件合約

---

## 需求摘要

當後端回傳 action（例如）：

```json
"actions": [
  {
    "type": "edit_file",
    "path": "hw2.R",
    "patches": [
      { "start_line": 9, "search": "...", "replace": "..." }
    ]
  }
]
```

我們在 `dispatchActions()` 執行這個 action 時，TUI / CLI 目前只顯示一行泛用文字：

```
    Dispatching 1 action(s)...
```

**希望改成顯示「正在做的具體 agentic work」**，把 action 的 `type`（與目標檔名）秀出來，與其它 phase 文案（`Building file context...`、`Running safety check...`、`Calling tutor API...`、`Continuation 1...`）一致：

```
    edit_file: hw2.R...
  ╭─ Review: hw2.R … ╮  ← 既有 diff review 框
  Applied: hw2.R          ← 既有 edit_applied
```

也就是「執行 `type: edit_file` 的同時，同步讓使用者在前端知道正在編輯哪個檔」。

---

## 現況分析（為什麼只有一行泛用文字）

### 事件源頭：`dispatchActions()`

[execute-tutor-use-case.ts](../tyla/src/application/use-cases/execute-tutor-use-case.ts) **line 409–421**：

```typescript
private async dispatchActions(actions: TutorAction[]): Promise<void> {
    if (actions.length === 0) return;
    this.deps.emit('phase_start', { phase: 'actions', description: `Dispatching ${actions.length} action(s)` });

    for (const action of actions) {
        switch (action.type) {
            case 'edit_file':      await this.dispatchEditFile(action); break;
            case 'execute_script': await this.dispatchExecuteScript(action); break;
        }
    }

    this.deps.emit('phase_end', { phase: 'actions', success: true });
}
```

問題：`phase_start` 在**整批 action 外面只發一次**，`description` 寫死成 `Dispatching N action(s)`，所以每個 action 的 `type` / `path` 從來沒被前端拿到。

### 前端兩個 presenter 都「已經」會渲染 `phase_start.description`

不用改 presenter——只要 `description` 變了，兩端自動跟著變：

| 端 | 檔案 / 行 | 現有渲染 |
|---|---|---|
| TUI (Ink) | [event-mapper.ts:84](../tyla/src/tui/presentation/event-mapper.ts#L84) | `makeMessage('status', `${event.data.description}...`)` |
| CLI (ora) | [agent-cli-presenter.ts:58-60](../tyla/src/cli/presentation/agent-cli-presenter.ts#L58) | `ctrl.setSpinner(ora(event.data.description).start())` |

### 只有 `edit_file` / `execute_script` 會進到 `dispatchActions`

`load_file` 在 **line 379** 已被 `.filter(a => a.type !== 'load_file')` 濾掉（它是 continuation driver 消化的，不是要執行的 action）。所以 switch 只需處理兩種；`describeAction` 對 `load_file` 仍給防禦性分支但實際走不到。

---

## 改動範圍：一個檔案、一個方法 +一個 helper

### 檔案：[execute-tutor-use-case.ts](../tyla/src/application/use-cases/execute-tutor-use-case.ts)

#### 改動 1：把 `phase_start` / `phase_end` 移進迴圈，逐 action 發

把現有 **line 409–421** 整段換成：

```typescript
private async dispatchActions(actions: TutorAction[]): Promise<void> {
    if (actions.length === 0) return;

    for (const action of actions) {
        // Per-action phase so the TUI/CLI surface the concrete agentic work
        // (e.g. "edit_file: hw2.R") instead of a generic "Dispatching N action(s)".
        // Both presenters already render phase_start.description, so no presenter
        // change is needed (event-mapper.ts §phase_start, agent-cli-presenter §phase_start).
        this.deps.emit('phase_start', { phase: 'actions', description: this.describeAction(action) });
        switch (action.type) {
            case 'edit_file':      await this.dispatchEditFile(action); break;
            case 'execute_script': await this.dispatchExecuteScript(action); break;
        }
        this.deps.emit('phase_end', { phase: 'actions', success: true });
    }
}

/**
 * Human-facing label for the action being dispatched. Shown verbatim by both
 * presenters as the phase status line. Includes the action type (the student
 * asked to see "edit_file" etc.) plus the target path for orientation.
 */
private describeAction(action: TutorAction): string {
    switch (action.type) {
        case 'edit_file':      return `edit_file: ${action.path}`;
        case 'execute_script': return 'execute_script';
        case 'load_file':      return `load_file: ${action.path}`;   // filtered upstream; defensive only
        default:               return 'action';
    }
}
```

**重點：**
- `phase_start`/`phase_end` 由「整批一次」改成「每個 action 一次」——多個 action 時每個都會各自亮一行 / 一個 spinner，逐步完成。
- 新增 `describeAction()` 把 `TutorAction` union 映成顯示字串。switch 已涵蓋三個 variant + default，無 exhaustiveness 風險。
- `phase: 'actions'` 維持不變，沿用既有 phase 語意。

---

## 改完後的前端流程（TUI）

```
    Calling tutor API...
    Continuation 1...
  🤖 The error arises because `quartiles_d123` ... I'll fix it now!
    edit_file: hw2.R...              ← 原本是「Dispatching 1 action(s)...」
  ╭─ Review: hw2.R ─────────────╮
  │  - deviations_d123 <- (quartiles_d123 - ...)         │
  │  + deviations_d123 <- (summary_d123$quartiles - ...) │
  │  Apply changes? [Y] Accept  [N] Reject               │
  ╰─────────────────────────────╯
    Applied: hw2.R                  ← 既有 edit_applied 事件
```

多個 action（例：先 `execute_script` 再 `edit_file`）會依序顯示：

```
    execute_script...
    edit_file: hw2.R...
```

---

## 標籤文案選項（唯一需要拍板的設計點）

`describeAction()` 回傳字串的格式。三個候選（推薦第 1 個）：

| # | 格式 | `edit_file` 範例 | `execute_script` 範例 | 備註 |
|---|---|---|---|
| **1（推薦）** | `type: path` | `edit_file: hw2.R` | `execute_script` | 與後端 action `type` 字面一致、含檔名定位，最貼近使用者原話「換成 Edit_file」 |
| 2 | 動詞句 | `Editing hw2.R` | `Running R script` | 較口語、但和 `type` 字面不同 |
| 3 | type + 細節 | `edit_file: hw2.R (1 patch)` | `execute_script (12 lines)` | 資訊最多、但較吵 |

> 若想完全照原話用大寫 `Edit_file`，把 case 改成回傳 `'Edit_file: ' + action.path` 即可——但 `type` 在 wire 上是小寫 `edit_file`，建議顯示與合約一致的小寫。

---

## 不需改的地方

- **事件合約 / 型別**：沿用既有 `phase_start` / `phase_end`，不新增 event type，不改 `AgentEvent`。
- **TUI `event-mapper.ts`**：`phase_start` 分支已渲染 `description`，零改動。
- **CLI `agent-cli-presenter.ts`**：`phase_start` 分支已用 `description` 起 spinner，零改動。
- **`dispatchEditFile` / `dispatchExecuteScript`**：內部已各自發 `diff_proposed` / `script_proposed` / `edit_applied` / `edit_rejected`，逐項 review/套用流程不變。
- **`TutorAction` 型別**（[tutor-actions.ts](../tyla/src/shared/types/tutor-actions.ts)）：不動。

---

## 測試影響

- 現有 [execute-tutor-use-case.test.ts](../tyla/tests/unit/application/execute-tutor-use-case.test.ts) 斷言的是 `edit_applied` / `edit_rejected` / `error` 等事件（line 160 等），**沒有任何測試斷言 `"Dispatching"` 字串**，故不會破。
- （選配）可加一條測試：給單一 `edit_file` action，斷言 events 內含
  `e.type === 'phase_start' && e.data.description === 'edit_file: hw11.R'`，鎖死新行為。

---

## 執行順序

1. 改 [execute-tutor-use-case.ts](../tyla/src/application/use-cases/execute-tutor-use-case.ts) `dispatchActions()`（搬迴圈）+ 新增 `describeAction()`。
2. `cd tyla && bun run build`（確認 TS 無誤；`describeAction` 的 union switch 全涵蓋）。
3. `cd tyla && bun run test`（現有測試應全綠）。
4. 手動驗收：跑一個會回 `edit_file` 的 tutor turn，確認 TUI 由「Dispatching 1 action(s)...」變「edit_file: hw2.R...」，且 diff review / Applied 流程不變。
5. （選配）補上述鎖定新文案的單元測試。

---

## 落地檢查清單

- [x] `dispatchActions()` 的 `phase_start`/`phase_end` 移進 `for` 迴圈，逐 action 發
- [x] 新增 `describeAction(action)` helper（含 default 防禦分支）
- [x] 採用推薦文案 `type: path`（`edit_file: <path>` / `execute_script`）
- [x] `bun run build` 通過（tsup 成功；另跑 `tsc --noEmit` 型別零錯誤）
- [x] `bun run test` 全綠（單元/整合全過；3 個 acceptance 失敗為既有環境問題——`.env` 設 `ACCEPTANCE_TEST_MODE=record` 且 `OPENAI_API_KEY` 失效，與本變更無關，已驗證 `inline` 模式下 3 個皆通過）
- [x] 單一 `edit_file` → 顯示 `edit_file: <path>...`（以新單元測試鎖定 `phase_start.description === 'edit_file: hw11.R'`）
- [ ] 手動確認：多個 action → 依序各亮一行（需 live tutor backend，未手動跑；邏輯由搬進迴圈的 `phase_start`/`phase_end` 保證）
- [ ] 手動確認：`execute_script` → 顯示 `execute_script...`（需 live tutor backend，未手動跑）
- [x] CLI（`tyla agent`）spinner 文案同步更新（與 TUI 共用同事件，免額外改動——已核對 [event-mapper.ts:84](../tyla/src/tui/presentation/event-mapper.ts#L84) 與 [agent-cli-presenter.ts:59](../tyla/src/cli/presentation/agent-cli-presenter.ts#L59)）

### 執行結果（2026-06-28）

- **程式碼變更**：`dispatchActions()` 已搬迴圈並新增 `describeAction()`（working tree 已含此 diff）。
- **測試新增**：[execute-tutor-use-case.test.ts](../tyla/tests/unit/application/execute-tutor-use-case.test.ts) 新增一條測試，斷言單一 `edit_file` action 會發出 `phase_start` 且 `description === 'edit_file: hw11.R'`（該檔 35 tests 全綠）。
- **未做的手動驗收**：步驟 4「跑一個會回 `edit_file` 的真實 tutor turn」需 guard+tutor 後端與有效 API key，本機環境（`.env` 的 OpenAI key 已失效）無法執行；改以上述單元測試覆蓋等效行為。
