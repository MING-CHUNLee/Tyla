# Plan: TUI 三項調整 — @-hint 英文化、單一 Y/N 提示、execute_script 顯示文案

日期：2026-06-12
範圍：純前端 presentation 層（`tyla/src/tui/`）。**不涉及** use case / gateway / 後端。
影響檔案：`AppController.tsx`、`Footer.tsx`、`DiffReview.tsx`、`App.tsx`（共 4 檔）。

## 0. 目標

User 在 tutor TUI 上要三個調整：

1. **@-hint 改成英文** — 目前送出無 `@` 的 prompt 時會跳一行中文提示，要改英文。
2. **Y/N 確認只出現一次** — 目前審核畫面同時有「審核框內」與「底部 Footer」兩處
   重複顯示 `[Y] Accept [N] Reject`，要收斂成一處。
3. **`execute_script` 的審核畫面文案要區分於 edit** — action 是 `execute_script`
   時，標題不該是 "Review"、確認句不該是 "Apply changes?"，而要是
   **"Execute"** 與 **"Execute script?"**。

**驗證流程**：實作完成後 `cd tyla && bun run build` 須編譯通過、`bun run test` 須全綠
（現有測試未斷言這些字串，預期不受影響，但仍須跑過確認）。

## 1. 現況

### Issue 1 — 中文 @-hint
- [`tyla/src/tui/controller/AppController.tsx:169-172`](../tyla/src/tui/controller/AppController.tsx#L169-L172)：
  tutor 模式下 prompt 不含 `@` 且本 session 尚未提示過時，呼叫
  `addStatusMessage('提示：可用 @檔名（如 @hw2.R）將檔案內容帶給 tutor')`。
  這是唯一一處（`src/` 內 grep 僅此一筆；`zh-TW.json` 內其他「提示」字樣與此無關）。

### Issue 2 — Y/N 重複兩處
審核（`appState === 'reviewing'`）時畫面上同時出現：
- **審核框內**（每種審核各自有一行）：
  - [`DiffReview.tsx:45-47`](../tyla/src/tui/presentation/components/DiffReview.tsx#L45-L47)：`Apply changes? [Y] Accept  [N] Reject`
  - [`InstallReview.tsx:68-70`](../tyla/src/tui/presentation/components/InstallReview.tsx#L68-L70)：`Proceed with installation? [Y] Accept  [N] Cancel`
- **底部 Footer**（持續存在的 chrome，兩行）：
  - [`Footer.tsx:41-43`](../tyla/src/tui/presentation/components/Footer.tsx#L41-L43)：`Review mode — press [Y] to accept, [N] to reject`
  - [`Footer.tsx:62-66`](../tyla/src/tui/presentation/components/Footer.tsx#L62-L66)（dim 行）：`[Y] Accept · [N] Reject`

→ 同一組按鍵提示出現 2~3 次，這就是附圖中的重複。

### Issue 3 — execute_script 沿用 edit 文案
- `execute_script` 並沒有獨立的審核元件。[`App.tsx:65-78`](../tyla/src/tui/presentation/App.tsx#L65-L78)
  把 `pendingApproval.kind === 'script'` 包成一個假的 `PendingEdit`
  （`path: '(r script)'`、所有行標成 `+ ` 綠色 added 行）後**直接重用 `DiffReview`**。
- 因此它繼承了 `DiffReview` 的 edit 風格文案：
  - 標題 [`DiffReview.tsx:36-38`](../tyla/src/tui/presentation/components/DiffReview.tsx#L36-L38)：`Review: (r script)`
  - 確認 [`DiffReview.tsx:45-47`](../tyla/src/tui/presentation/components/DiffReview.tsx#L45-L47)：`Apply changes? [Y] Accept  [N] Reject`
- `DiffReview` 目前完全不知道自己在渲染 edit 還是 script（沒有任何 variant 資訊）。

## 2. 設計

### 2.1 Issue 1 — 英文化（單行字串替換）
`AppController.tsx:171` 改為：

```ts
addStatusMessage('Tip: type @filename (e.g. @hw2.R) to share a file with the tutor.');
```

（措辭可微調；不影響 `@`-gating 邏輯，純文案。）

### 2.2 Issue 2 — 單一 Y/N 來源（建議：保留「審核框內」，移除 Footer 的按鍵字樣）

**理由**：Issue 3 要求審核框內的確認句必須隨 action 類型變化
（"Apply changes?" / "Execute script?" / "Proceed with installation?"）。
框內的句子本來就是 context-specific 的最佳落點；Footer 是全域 chrome，
不應該複製這組按鍵、也不該為了 Issue 3 變成 action-aware（會多牽一條
`pendingApproval.kind` 傳進 Footer 的線）。所以**框內保留為唯一來源、Footer 去鍵**。

`Footer.tsx` reviewing 分支改為「有狀態指示但不含按鍵」：
- 第 41-43 行（黃色 banner）：`Review mode — press [Y] to accept, [N] to reject`
  → `Review mode`（去掉按鍵字樣，僅保留狀態 banner）。
- 第 62-66 行（dim 行）reviewing 分支的 `[Y] Accept · [N] Reject`
  → 改為中性提示（例如 `Respond in the review box above`）或留空。

結果：`[Y]…[N]…` 按鍵只剩審核框內一處。`DiffReview` / `InstallReview` 框內那行**保留不動**
（InstallReview 的 "Proceed with installation? [Y] Accept [N] Cancel" 維持原樣）。

> 替代方案（若 user 偏好）：反過來保留 Footer 的按鍵、移除三個審核框內的確認行。
> 但這樣 Issue 3 的「Execute script?」就得讓 Footer 知道 `pendingApproval.kind`，
> 需多傳一個 prop 進 Footer，較不乾淨 —— 故**不建議**。詳見 §4 待確認 Q1。

### 2.3 Issue 3 — 讓 DiffReview 具備 variant，區分 edit / script

在 `DiffReview` 加一個可選 prop（預設維持 edit 行為，向後相容）：

```tsx
interface DiffReviewProps {
    edit: PendingEdit;
    onDecision: (approved: boolean) => void;
    variant?: 'edit' | 'script';   // 控制標題動詞與確認句；預設 'edit'
}
```

元件內：

```tsx
const isScript = variant === 'script';
// 標題（DiffReview.tsx:36-38）
<Text bold color="yellow">{isScript ? 'Execute' : 'Review'}: {edit.path}</Text>
// 確認句（DiffReview.tsx:45-47）
<Text color="yellow" bold>
    {isScript ? 'Execute script? [Y] Accept  [N] Reject'
              : 'Apply changes? [Y] Accept  [N] Reject'}
</Text>
```

`App.tsx` script 分支（第 65-78 行）傳入 `variant="script"`：

```tsx
{appState === 'reviewing' && pendingApproval?.kind === 'script' && (
    <DiffReview
        variant="script"
        edit={{
            path: 'R script',          // 由 '(r script)' 改成 'R script'，標題讀作 "Execute: R script"
            diff: pendingApproval.script.code,
            original: '',
            proposed: pendingApproval.script.code,
            diffLines: pendingApproval.script.code
                .split('\n')
                .map(line => ({ kind: 'added' as const, text: `+ ${line}` })),
        }}
        onDecision={onReviewDecision}
    />
)}
```

edit 分支（第 58-63 行）不傳 variant → 走預設 `'edit'`，行為完全不變。

**結果對照**：

| 狀況 | 標題 | 確認句 |
|------|------|--------|
| `edit_file`（現況保留） | `Review: <path>` | `Apply changes? [Y] Accept [N] Reject` |
| `execute_script`（本次改） | `Execute: R script` | `Execute script? [Y] Accept [N] Reject` |

> 可選 polish（非必須，預設不做）：script variant 的程式碼目前每行都加綠色 `+ ` 前綴
> （沿用 diff 視覺）。execute 不是 diff，可考慮 script variant 不加 `+ `、改中性顏色，
> 讓「這是要執行的程式碼」更直覺。是否要做見 §4 Q2 附帶項。

## 3. 變更清單（逐檔）

| 檔案 | 變更 |
|------|------|
| `tui/controller/AppController.tsx` | L171 中文 hint → 英文（Issue 1） |
| `tui/presentation/components/Footer.tsx` | reviewing 分支 L41-43、L62-66 去掉重複按鍵字樣（Issue 2） |
| `tui/presentation/components/DiffReview.tsx` | 加 `variant?: 'edit'\|'script'` prop；標題動詞與確認句依 variant 切換（Issue 3） |
| `tui/presentation/App.tsx` | script 分支傳 `variant="script"`、`path` 改 `'R script'`（Issue 3） |

`InstallReview.tsx` **不需改**（其框內確認行保留，作為 install 的唯一 Y/N 來源）。

## 4. 已確認決策（2026-06-12）

- **Q1（Issue 2 收斂方向）→ 保留「審核框內」**。框內那行為唯一 Y/N 來源，
  Footer reviewing 分支改為去鍵的 `Review mode` 狀態 banner（§2.2 主方案）。
- **Q2（Issue 3 execute 確認句按鍵字樣）→ `Execute script? [Y] Accept  [N] Reject`**
  （與 edit 一致、改動最小）。§2.3 結尾的「script 不加綠色 `+ ` 前綴」polish **暫不做**。
- **Q3（措辭）**：採 §2.1 / §2.3 的預設用字（`Tip: type @filename …` 與 `Execute: R script`），
  user 未要求調整。

→ 三項皆定案，可直接進實作。

## 5. 風險 / 範圍

- 純文案 + 一個 presentation prop，無邏輯/資料流變動，不碰 use case、event、gateway。
- 現有測試未斷言這些 UI 字串（已 grep `tests/` 確認），預期不影響測試；仍須 `bun run test` 跑過。
- 向後相容：`DiffReview` 的 `variant` 為 optional 且預設 `'edit'`，既有 edit 呼叫端不受影響。
