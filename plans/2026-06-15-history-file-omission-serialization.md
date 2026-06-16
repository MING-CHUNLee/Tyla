# History 檔案省略壓縮 — 前端實作落地（File-Omission History Serialization）

**Date:** 2026-06-15
**Status:** 規格已對齊真實 schema，可實作
**Repo:** MindyCLI_demo（前端）。後端零邏輯改動。
**Companion（後端評估）:** `Tyla-api/plans/2026-06-14-history-file-omission-compression.md`
— 設計理由、context-engineering 框架、後端為何不動，都在那份；本份只談**前端怎麼接**。

---

## 0. TL;DR（給實作者）

- **改動落點只有一處核心**：[conversation-session.ts](../tyla/src/domain/entities/conversation-session.ts)
  的 `getHistory()`（L116-117）目前 `flatMap(t => t.toHistoryMessages())`，把每個 turn 的
  `userMessage` / `assistantMessage` **原封** dump 進 history。把它換成 `serializeTurnToHistory(turn)`。
- **素材已經在 turn 裡**：proposed actions 在 `turn.apiLogs` 的 **response payload**，applied edits 在
  `turn.fileChanges`，看過的檔在 **request payload 的 `file_context`**。全部不用改資料結構，只是**讀法改變**。
- **三件事必須做對**（否則出 bug，見 §4）：
  1. action-only turn 的 `assistantMessage` 是 **`""`** → 不合成就送出空字串 → 後端 contract `400`。
  2. placeholder 措辭**別用 "Loaded"**（那是後端 tool 的 live-狀態保留字，會誘導模型跳過 load_file）。
  3. **tutor turn 的 `fileChanges`/`outputs` 恆為 `[]`**（[agent-service.ts:286](../tyla/src/application/services/agent-service.ts#L286)）
     → **無法**從 session 區分 edit 是否被套用、也拿不到 script 執行結果。edit 一律用**中性措辭**
     渲染、交給 live `file_context` 當權威（§3.3 路 A）。這推翻了兩份 plan 原本「比對 fileChanges 判定
     applied」的假設。

---

## 1. 確切的改動點（已驗證）

### 1.1 現況：history 直接逐字 dump

```ts
// conversation-session.ts L114-118
getHistory(): SessionMessage[] {
    return this._turns.flatMap(t => t.toHistoryMessages());
}
```

```ts
// conversation-turn.ts L66-72
toHistoryMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [
        { role: 'user', content: this.userMessage },          // 原封
        { role: 'assistant', content: this.assistantMessage },// 可能是 "" ← 見 §4.1
    ];
}
```

呼叫鏈：[agent-service.ts:381](../tyla/src/application/services/agent-service.ts#L381)
`this.session.getHistory().map(...)` → 傳給 tutor use-case 當 `history`。

### 1.2 目標：用 `serializeTurnToHistory(turn)` 取代 `toHistoryMessages()`

建議把新邏輯放成 `ConversationTurn` 的方法（或獨立 pure function 吃 turn），`getHistory()` 改呼叫它。
保持簽章不變：輸出仍是 `Array<{ role, content }>`，下游全部不動。

---

## 2. 素材在哪（已逐欄驗證，附 file:line）

| 需要的資料 | 來源欄位 | 驗證出處 |
|---|---|---|
| 使用者意圖 | `turn.userMessage` | conversation-turn.ts L39 |
| 終端 prose | `turn.assistantMessage`（= 後端終端 `content`） | agent-service.ts:286 存的是 `result.content` |
| 模型**提議**的 actions | `turn.apiLogs` 中 `source:'tutor' && direction:'response'` 的 **最後一筆** `payload.actions` | execute-tutor-use-case.ts:280-281；payload=後端 DTO `data`，含 `actions`（tutor-chat-gateway.ts:11-19） |
| 模型**看過**哪些檔 | 同上 turn 中 **最後一筆** `source:'tutor' && direction:'request'` 的 `payload.file_context` | request payload = gateway `body`，含 `file_context`（tutor-chat-gateway.ts:64-73） |
| ~~實際已套用的改動~~ | ~~`turn.fileChanges`~~ → **tutor turn 恆為 `[]`** | agent-service.ts:286（見 §3.3 ⚠️） |
| ~~execute_script 結果~~ | ~~`turn.outputs`~~ → **tutor turn 恆為 `[]`**；且 `LLMOutput` 只有 `code/analysis/report` 文字、無 stderr | llm-output.ts L13；agent-service.ts:286 |

**`apiLogs` 是 optional**（conversation-turn.ts L45 / L83：無 rawExchange 就不寫）。舊 session 或 guard-only
turn 可能沒有 → `serializeTurnToHistory` 必須**優雅退回**目前的逐字 `toHistoryMessages()` 行為，不可 throw。

---

## 3. 三個被真實 schema 改寫的設計細節

### 3.1 多筆 tutor apiLog 的唯一來源是 B3 續傳（已確認）

[execute-tutor-use-case.ts:258-340](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L258) 的
`for` 迴圈每次 continuation 都 push 一對 tutor request/response（L279-282）。所以**一個 student turn 在
`apiLogs` 裡可能有多對** tutor req/resp——但**只因 B3 載檔續傳**。後端 hybrid-lazy 的 round1/round2 在
後端單一 HTTP 內完成，**不會**出現在前端 `apiLogs`。

→ 序列化時把整個 turn 收斂成**一對** user/assistant：取**最後一筆** response 為終端。

### 3.2 `seenPaths` 不必跨 request union——終端 request 已含全部

`fileContext = loadedBlocks.join('')`（[execute-tutor-use-case.ts:263](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L263)），
而 `loadedBlocks` 在續傳中**只增不減**。所以**最後一筆 request 的 `file_context` 已累積本 turn 全部載入的
檔**。直接對它跑 `extractHeaderPaths` 即可，無需 union 多筆 request。

`file_context` 是 flat 的 `### <path>` 區塊、**無 `## ` 標頭**（同檔 L259-262 註解明示）。
`extractHeaderPaths` 抓 `^### (.+)$`、丟所有 `N| ` 內容行即可。

### 3.3 ⚠️ 改寫：tutor turn 的 `fileChanges` / `outputs` **目前永遠是空的**

兩份 plan（含後端 2026-06-14 §3.3）原本假設「比對 `apiLogs`（提議）vs `fileChanges`（已套用）即可
判定 applied / not-applied」。**讀完前端碼後，這個假設在 tutor 路徑上不成立。**

證據鏈：

- tutor turn 由 [agent-service.ts:286](../tyla/src/application/services/agent-service.ts#L286) 建立：
  `addTurn(instruction, result.content, result.usage, [], [], result.apiLogs)`
  —— **fileChanges 與 outputs 都硬傳 `[]`**。（對比 L330/L343 的 agentic 路徑才有填。）
- 學生的 approve / reject 決定，是 [execute-tutor-use-case.ts:400-405](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L400)
  以 `edit_applied` / `edit_rejected` **事件**發出去的，**沒寫回 turn**。
- execute_script 的執行結果也一樣：[L418](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L418)
  `emit('tool_result_r_exec', ...)` 後即丟棄，**不入 turn**。

結論：用現有 session 資料，**無法**區分某個 edit 是被套用還是被拒絕——`turn.fileChanges` 恆為 `[]`，
`appliesPatch` 永遠回 false → 全部會被標成「not yet applied」。而若該 edit 其實**被套用了**，下一輪
live `file_context` 會顯示新內容，history 卻說「not yet applied」→ 正是後端 plan §3.3 警告的矛盾（反向）。

兩條路二選一：

**路 A（零前置、建議先做）— 中性措辭，不主張套用狀態。**
edit 一律渲染成 `Suggested editing \`<path>\` (line N): X → Y`，**不寫 "Edited" 也不寫 "(not yet
applied)"**。把「到底改了沒」完全交給下一輪 live `file_context`（權威來源）+ 系統 prompt 那句
「衝突以 file_context 為準」。這樣就**繞開了根本沒記錄的狀態**，不會謊報。`appliesPatch` 不需要。

**路 B（要忠實 applied/proposed 才做）— 先補持久化。**
在 tutor turn 上記錄 approve/reject 結果（例如 apply 時把 `FileChange` 塞進 `addTurn` 的第 4 參數，
或在 `TurnJSON` 加一個 `appliedEdits` 旗標）。**這是獨立的前置工程，不屬本壓縮案**；補完後才談得上
比對。注意即使補了，FileChange schema 仍不存 per-patch search/replace（見下），比對仍是 contains 啟發式。

> **FileChange schema 旁註**（[file-change.ts:12-20](../tyla/src/domain/entities/file-change.ts#L12)）：
> `{ id, type:'edit'|'diff', path, content, createdAt }`，`content` 是**整檔內容或 raw diff**，
> **不存** per-patch search/replace。所以即便走路 B，`appliesPatch` 也只能用
> `fc.content.includes(patch.replace.trim())` 這種 contains 啟發式，比不出來預設「未套用」。

**本文件以下章節採路 A。**

---

## 4. 三個必做的正確性處理

### 4.1 action-only turn 的 `assistantMessage` 是 `""` → 必須合成

後端只在 `prose 空 && actions 空` 時才注入 FALLBACK_PROSE。若模型**有 edit_file 但無 prose**
（demo 範例 turn 1 即如此），`turn.assistantMessage` 存成 **`""`**。直接放進 history →
後端 contract `required(:content).filled(:string)` → **整個 request 400**。

→ assistant 條目必須由 prose + 渲染後的 actions 組成；兩者皆空時退回 `"(No actionable reply.)"`。

### 4.2 placeholder 措辭避開 tool 保留字

user 條目尾端附：

```
[Previously inspected last turn (contents not included now; call load_file to see them again): hw2.R]
```

**不要**寫 "Loaded last turn"——"loaded"/"live"/"shown" 在後端 tool 描述裡專指「現在就在
Student Workspace (live)」，會誘導模型直接 `edit_file` 跳過 `load_file`，被後端 gate 攔下回
`edit_file_redirected`、白繞一輪。

### 4.3 `userMessage` 要 strip 貼入的大段 code

學生把整支檔貼進聊天框是常態；逐字保留會讓本壓縮失效。對 `userMessage` 內的 fenced code block
（```` ``` ````）或連續 `N| ` 區塊套 `PASTE_CAP`，超過換 `[pasted code omitted; ask to re-share if needed]`。
**只壓貼入的 code，保留問句意圖**。

---

## 5. `serializeTurnToHistory(turn)` — 落地虛擬碼

```ts
function serializeTurnToHistory(turn: ConversationTurn): SessionMessage[] {
    // 退路：沒有 apiLogs（舊 session / guard-only）→ 維持現行逐字行為
    const tutorLogs = (turn.apiLogs ?? []).filter(l => l.source === 'tutor');
    if (tutorLogs.length === 0) return turn.toHistoryMessages();

    const lastReq  = lastWhere(tutorLogs, l => l.direction === 'request')?.payload as any;
    const lastResp = lastWhere(tutorLogs, l => l.direction === 'response')?.payload as any;

    const seenPaths = extractHeaderPaths(lastReq?.file_context ?? '');           // §3.2
    const prose     = (turn.assistantMessage ?? '').trim() || (lastResp?.content ?? '');
    const actions   = (Array.isArray(lastResp?.actions) ? lastResp.actions : [])
                        .filter((a: any) => a?.type !== 'load_file');             // load_file 是續傳 plumbing

    // ── user 條目 ──
    let userContent = stripPastedCode(turn.userMessage);                          // §4.3
    if (userContent.trim() === '') return [];                                     // 理論上不該發生 → 跳過整 turn
    if (seenPaths.length > 0) {
        userContent += `\n\n[Previously inspected last turn (contents not included now; `
                     + `call load_file to see them again): ${seenPaths.join(', ')}]`;  // §4.2
    }

    // ── assistant 條目 ──
    const lines: string[] = [];
    if (prose.trim()) lines.push(truncate(prose.trim(), PROSE_CAP));
    for (const a of actions) {
        const rendered = renderAction(a);                                         // §3.3 路 A：不看 fileChanges
        if (rendered) lines.push(rendered);
    }
    let asstContent = lines.join('\n');
    if (asstContent.trim() === '') asstContent = '(No actionable reply.)';        // §4.1 保命

    return [
        { role: 'user',      content: userContent },
        { role: 'assistant', content: asstContent },
    ];
}
```

`renderAction(a)`（採路 A，§3.3）：
- `edit_file`：每個 patch 一段，**中性措辭、不主張套用狀態**：
  `Suggested editing \`<path>\` (line N): <body>`；body 單行用 `` `search` → `replace` ``，
  多行用 `-/+` diff block；search/replace 各套 `PATCH_CAP`。**不查 fileChanges、不寫 Edited/not-applied。**
- `execute_script`：`Suggested a demo script: \`<truncate(code, SCRIPT_CAP)>\``。
  **執行結果（stdout/stderr）不寫**——前端目前根本沒把它存進 turn（§3.3：L418 emit 後即丟）。
  若要保留錯誤情境，須先做路 B 類的持久化前置（§7）。
- 其他/未知 type → 回 `null`（跳過）。

**配對不變量**：每個 turn 回傳**恰一對**或**空陣列**（degenerate）。Anthropic 要求首則為 user 且嚴格交替
（後端 `anthropic_client.rb` 直接映射 history），單推一條會破壞交替。

---

## 6. 常數（暫定，需用真實 session 校準）

```ts
const PROSE_CAP  = 600;
const PATCH_CAP  = 400;
const SCRIPT_CAP = 200;
const PASTE_CAP  = 200;   // §4.3
// （原 ERROR_TAIL_CAP 已移除：execute_script 結果未持久化，路 A 不寫錯誤 tail。見 §3.3 / §7。）
// 截斷以字元計，但避免切斷多位元組字元 / 切進 ``` fence。
```

---

## 7. 仍需前端自己決定 / 確認的點

1. **proposed-vs-applied 走路 A 還路 B**（§3.3）。建議**先路 A**（中性措辭、零前置）先把壓縮上線；
   若日後 demo 顯示模型常重複提議已套用的 edit，再評估路 B（持久化 approve/reject 結果到 turn）。
2. **是否要保留 execute_script 錯誤情境**（對齊「回報錯誤時 LLM 至少知道發生什麼」）。要的話前置工作是：
   把 [L418](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L418) 的 `r_exec` 結果寫進
   `turn.outputs`（或新欄位），序列化才取得到。**本壓縮案不含此前置**。
3. **`serializeTurnToHistory` 放哪**：建議放 `ConversationTurn`（與 `toHistoryMessages` 並列），
   `getHistory()` 改呼叫；舊 `toHistoryMessages` 保留作退路（§5 fallback 與既有測試）。
4. **常數實際值**（§6）+ 是否值得加 `### <path>` 檔頭的共用常數（前後端格式約定，避免靜默漏抓）。
5. **Phase 0 量測（建議必做）**：在 `getHistory()` 前後 log history 字元/估算 token，跑幾條真實對話，
   驗證對後端 `history_truncated` 與 rolling-summary 觸發率的影響。

---

## 8. 驗收

- 範例 turn 1（`assistantMessage:""`、edit_file 提議）序列化後：
  - user：原問句 + `[Previously inspected ... : hw2.R]`
  - assistant：`Suggested editing \`hw2.R\` (line 8): \`...0.50...\` → \`...0.5...\``（中性措辭，路 A）
  - 兩條皆非空 → 不會 400。
- 新增單元測試：action-only turn 不產生空 content；無 `apiLogs` 的 turn 退回逐字；B3 多續傳 turn 收斂成一對；
  edit 用中性措辭、不含 "applied/not applied" 字樣；貼入大段 code 被 strip；回傳恰一對或空陣列（配對不變量）。
```
