# Frontend Context Optimization — Design

**Date:** 2026-06-06
**Status:** 設計提案（待選定起手項）
**Scope:** `execute-tutor-use-case.ts` 的 `file_context` 組裝（Option B / gateway 路徑），
以及與之相關的 `load_file` 回路。**不改 wire contract**（F1/F2/F4 都是前端內部行為）。
**參考:**
- 後端壓縮計畫（本案的對側）：
  [`Tyla-api/plans/2026-06-06-prompt-compression-mechanism.md`](../../Tyla-api/plans/2026-06-06-prompt-compression-mechanism.md)
- 既有前端計畫：[`2026-06-02-gateway-file-context.md`](./2026-06-02-gateway-file-context.md)
  （其 §Part 4 Step 4「token budget guard」**從未實作**——見 F2）
- Anthropic, *Effective context engineering for AI agents* — 下文以〔CE〕標注。

---

## 0. TL;DR

後端計畫在處理「system prompt 太大、被迫丟掉 history」的問題，但**膨脹的源頭在前端**：
`file_context` 由本檔 `buildFileContext()` 組出，目前 **(a) 因一個比對 bug 幾乎每回合
都塞進「全部」R 檔、(b) 完全沒有 token 上限**。

〔CE〕：「最便宜的 token 是根本沒送出去的那個」。因此**前端把 `file_context` 收斂到合理
大小，比後端事後壓縮更治本**，且應**排在後端 `HistorySummarizer` 之前**——前端先讓出
budget，後端的 rolling summary 才有空間放得進去。

---

## 1. 問題：前端是 8K 預算壓力的源頭

### 1.1 資料流

```
execute-tutor-use-case.ts
  buildFileContext(instruction)
    ├─ file_scan        → projectContext + scannedFiles（含每個檔名/路徑）
    ├─ readRelevantFiles(instruction, scannedFiles)   ← F1 的 bug 在這
    │     └─ 命中 → readFiles() 串接「整份檔案內容」（無上限）  ← F2
    └─ readFallbackFiles()（top-5）  ← 因 F1 幾乎是死碼
  → file_context 字串
        │  POST /api/v1/tutor_chats { ..., file_context }
        ▼
後端 BudgetAwarePromptAssembler（8K hard cap on GitHub Models）
  base(persona+assignment+solution+prompt) ~5K  → 必留
  file_context（whole-or-drop、優先於 history）   → 前端送多大就吃多大
  history                                         → 被擠光（後端計畫 §1.2：剩 ~350）
```

### 1.2 與後端計畫的關係

| | 後端計畫 | 本案（前端） |
|---|---|---|
| 手段 | history rolling summary（多一次 LLM 呼叫） | 在**源頭**裁切 file_context（零 LLM 成本） |
| 對應〔CE〕 | compaction | smallest high-signal token set / just-in-time |
| 順序 | 後做 | **先做**（先讓出 budget） |

> 兩者互補、不互斥。前端 F1+F2 修好後，後端的 summary 才真的有 budget 落地；
> 否則 file_context 仍會把 history 連同 summary 一起擠掉。

---

## 2. 發現（按影響力排序）

### 🔴 F1 — 副檔名比對 bug：幾乎每回合都讀「全部」R 檔

[`execute-tutor-use-case.ts:340-346`](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L340-L346)：

```ts
const ext = path.extname(nameLower).slice(1);            // "hw11.r" → "r"
return ext.length > 0 && instructionLower.includes(ext); // includes("r")
```

`.R` 的 ext 是單字母 `"r"`，**幾乎每句英文都含 r**（help、error、your、function…）→
對**每一個** `.R` 檔恆真。後果：

- `readRelevantFiles` 讀進**全部** `.R` 檔，且**無數量上限**；
- 用來保護預算的 `readFallbackFiles`（`FALLBACK_FILE_LIMIT = 5`）**幾乎成死碼**
  （relevant 分支先命中、又沒 cap）；
- R 教學工具裡 `.R` 正是最常見檔型——over-read 打在最痛的地方。

→ 這就是後端被迫 DROP 整段 history 的**根因之一**。

### 🔴 F2 — `file_context` 完全沒有 token 上限

[`readFiles():352-367`](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L352-L367)
把整份檔案原文串接，**無單檔截斷、無總量 cap**。一個大的 `.Rmd` 就能吃光 8K。

關鍵：**前端早就有現成工具，只是 tutor 路徑沒用**——

- `estimateTokens()` 已存在：[`section-builders.ts:258`](../tyla/src/application/prompts/section-builders.ts#L258)
  （由 [`prompts/index.ts`](../tyla/src/application/prompts/index.ts) 匯出）；
- **precedent**：[`execute-ask-use-case.ts`](../tyla/src/application/use-cases/execute-ask-use-case.ts)
  已用 `MAX_CONTEXT_TOKENS = 6_000` + `estimateTokens` 對 file_context 做逐塊預算裁切；
- 而 [`2026-06-02-gateway-file-context.md`](./2026-06-02-gateway-file-context.md) §Part 4 **Step 4
  就寫了** `truncateToTokenBudget()` 這個 guard——**但 `execute-tutor-use-case.ts` 從沒實作它**。

→ F2 不是新建設施，是**把既有且已驗證的 pattern 補進 tutor 路徑**。

〔CE〕觀點：`file_scan` 已給你**輕量識別碼（檔名/路徑）**，這正是 just-in-time 該優先送的
東西；整份檔案內容應「按需」才送（見 F3 / `load_file`）。

### 🟠 F3 — `load_file` 回路沒接回 tutor

[`dispatchLoadFile():260-265`](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L260-L265)
把讀到的檔案內容 `emit('text_output')`——**印給使用者看**，**從未**餵回 tutor LLM 做下一輪。
也就是 LLM 發出的 `load_file` 請求，內容**到不了 LLM**。

這對齊後端計畫 §8-5 釘的「`load_file` 跨回合、前端中介」模式——但**前端這半段是斷的**：
正確流程是「回合 N 收到 `load_file` action → 前端讀檔 → 放進**回合 N+1 的 `file_context`**」，
而現在只是把檔案內容當聊天輸出印掉。

### 🟡 F4 — `file_context` 在 guard 之前就組好

[`callGateway()`](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L116)
第 116 行 `buildFileContext` 跑在 guard 呼叫（122）**之前**。guard 判 `forbidden` 時，
剛剛的 scan + 讀檔全白做，還在拒絕前多加延遲。把它移到 guard 通過後即可。

---

## 3. 與後端的協調點

1. **file_context budget ↔ 後端 whole-or-drop**：後端對 file_context 是「優先且整塊保留」
   （後端計畫 §4 step 2）。所以**前端送多大、後端就吃多大、history 就被擠多少**。前端的
   cap 值（F2）直接決定後端 rolling summary 有沒有空間 → **兩邊的數值要一起校準**
   （見 §6 Phase 0）。起點建議：file_context ≲ **2 000–2 500 tokens**（讓 8K −〜5K 靜態
   後仍留得住 history + summary），實測後定。

2. **可能的雙重計算（待後端確認）**：後端 `assemble_prompt` 同時放
   `student_file`（後端 `StudentFileLoader` 從自己的 fixture 載）**和**前端送的 `file_context`。
   若兩者都帶學生程式碼，會**重複佔 token**。需與後端確認職責邊界：
   學生「當前 workspace」由前端 `file_context` 負責，後端是否還需重複載 canonical 檔？

3. **`load_file` 跨回合契約（對齊後端 §8-5）**：後端把 `load_file` 當 action 原封回傳，
   不在 server 端 loop；**前端必須負責**「讀檔 → 併入下一回合 file_context」。F3 是這條
   契約的前端落實。

---

## 4. 各項修法（concrete）

### F1 — 收緊副檔名比對 + 替 relevant 分支補 cap

把 `instructionLower.includes(ext)` 換成「**有邊界的點號副檔名**」比對，並對命中數設上限：

```ts
// 只在指令明確提到 ".r" / ".rmd"（前面是非英數邊界）時才算副檔名命中
const extHit = (ext: string) =>
    ext.length > 0 && new RegExp(`(^|[^a-z0-9])\\.${ext}\\b`).test(instructionLower);

const readTargets = scannedFiles.filter(file => {
    const nameLower = file.name.toLowerCase();
    if (instructionLower.includes(nameLower)) return true;          // 明確檔名
    return extHit(path.extname(nameLower).slice(1));                // ".R file" 才命中
}).slice(0, FALLBACK_FILE_LIMIT);                                    // ← relevant 也設上限
```

> 效果：「help me fix my code」不再觸發全讀；「look at my hw11.R」「the .R file」仍命中。

### F2 — 對 file_context 套用既有的 token 預算裁切

沿用 `execute-ask-use-case.ts` 已驗證的 pattern，在 `buildFileContext` 回傳前裁切：

```ts
import { estimateTokens } from '../prompts';
const FILE_CONTEXT_TOKEN_CAP = 2_200;   // §6 Phase 0 與後端一起校準

private capFileContext(text: string, cap: number): string {
    if (estimateTokens(text) <= cap) return text;
    return text.slice(0, cap * 4) + '\n[…truncated for token budget]';   // 同 ask 路徑的估法
}
```

- 先對**單檔**截斷（`readFiles` 內，避免一個大檔吃掉整個額度），再對**總量**套 `capFileContext`；
- 落實 [`2026-06-02-gateway-file-context.md`](./2026-06-02-gateway-file-context.md) Step 4 那個一直沒做的 guard。

### F3 — 把 `load_file` 接回下一回合（跨回合）

`dispatchLoadFile` 不應把檔案內容當聊天輸出，而應**暫存**起來，於**下一次** `callGateway`
併入 `file_context`：

```ts
private pendingLoads = new Map<string, string>();   // path → content（本 session）

private async dispatchLoadFile(action: { path: string }): Promise<void> {
    const tool = this.deps.registry.get(action.path.toLowerCase().endsWith('.pdf') ? 'pdf_read' : 'file_read');
    if (!tool) return;
    const res = await tool.execute({ path: action.path });
    if (!res.isError) {
        this.pendingLoads.set(action.path, res.content);              // 不再 emit 給使用者
        this.deps.emit('status_update', { info: `loaded ${action.path} for next turn` });
    }
}
```

`buildFileContext` 起頭把 `pendingLoads` 併入（並標 `### <path>`），送出後清空。
（若暫時不想做跨回合，最低限度也要把現在的 `emit('text_output')` 改成明確標示
「this is the requested file, not tutor output」，避免誤導。）

### F4 — 把 `buildFileContext` 移到 guard 通過後

把第 116 行的 `buildFileContext` 呼叫**下移**到 guard 的 `forbidden`/`error` 檢查之後、
tutor 呼叫之前。forbidden 的學生不再付出 scan + 讀檔的 I/O 與延遲。

---

## 5. 不變的東西（contract 不動）

- **Wire format 不變**：F1/F2/F4 都是 `buildFileContext` 內部行為；
  `tutor-chat-gateway.ts` 的 `send()` body 形狀不動。
- **後端不需為 F1/F2/F4 改任何東西**——它們只是讓前端少送 / 送更精準的 `file_context`。
- F3 也走**既有** `load_file` action 契約，只是把回讀內容導向下一回合 file_context，
  不新增欄位。
- guard / tutor 兩段式 pipeline、approval gate、actions dispatch 全部不變。

---

## 6. 階段

- **Phase 0 — 量測（與後端 Phase 0 同步）**：在 `buildFileContext` 回傳前用 `estimateTokens`
  把 file_context 估值寫進 `debugLog('tutor', ...)`，對照後端回傳的 `usage.input_tokens`，
  量出「file_context 實際多大、多常把 history 擠光」。**零風險、先給數據再定 cap 值。**
- **Phase 1 — F1 + F2（源頭止血，排在後端 HistorySummarizer 之前）**：
  - F1：收緊比對 + relevant 分支設 cap；
  - F2：套用 `estimateTokens` + `FILE_CONTEXT_TOKEN_CAP`（單檔 + 總量兩段）。
  - 與後端一起敲定 `FILE_CONTEXT_TOKEN_CAP` ↔ 後端 `SUMMARY_TOKEN_CAP` 的分配。
- **Phase 2 — F4（小）+ F3（需設計跨回合）**：F4 一行搬移即可；F3 涉及 `pendingLoads`
  狀態與下一回合併入，獨立成 task。

---

## 7. 測試 checklist

- [ ] F1：instruction = "help me fix my code"（含 r 但未提檔）→ relevant 分支**不**命中、
      落到 fallback（top-5）。
- [ ] F1：instruction = "look at hw11.R" → 只命中 `hw11.R`。
- [ ] F1：relevant 命中超過 5 檔時，輸出**最多 5 檔**。
- [ ] F2：大檔（> cap）→ file_context 被截斷且帶 `[…truncated]` 標記，`estimateTokens` ≤ cap。
- [ ] F2：小 workspace → 不截斷、行為同今天。
- [ ] F4：guard 回 forbidden 時，`buildFileContext` **未被呼叫**（不做 scan/讀檔）。
- [ ] F3：`load_file` action → 內容不再以 tutor 輸出印出；下一回合 `file_context` 含該檔。
- [ ] Regression：wire body（`tutor-chat-gateway.send`）形狀不變。

---

## 8. 待決定

1. `FILE_CONTEXT_TOKEN_CAP` 的值（暫定 ~2 200；Phase 0 + 與後端聯合校準後定）。
2. 單檔截斷上限要不要也參數化（避免單一大檔吃掉整個額度）。
3. F3 跨回合是否納入本案，或拆成獨立 task（牽涉 `pendingLoads` session 狀態）。
4. §3-2 的雙重計算：與後端確認 `StudentFileLoader`（後端 fixture）vs 前端 `file_context`
   是否重疊、誰負責「學生當前 workspace」。
