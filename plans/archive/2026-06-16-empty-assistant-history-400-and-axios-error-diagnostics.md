# Plan: 空字串 assistant history 造成 tutor 400 + AxiosError 細節無法診斷

日期：2026-06-16
範圍：
- `tyla/src/domain/entities/conversation-turn.ts`（history 序列化）
- `tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts`（tutor HTTP client）
- `tyla/src/infrastructure/api/guard/guard-check-gateway.ts`（guard HTTP client）
- `tyla/src/application/use-cases/execute-tutor-use-case.ts`（`failTutor` 錯誤訊息）

關聯 log：guard log_id 190/193、tutor log_id 192（空 content 回覆）；失敗請求為
prompt `"Show me a histogram demo and open the sample data"`（debug.log 第 518 行 REQUEST，無對應 RESPONSE）

---

## 0. 問題描述

TUI 連續操作後出現：

```
> Show me a histogram demo and open the sample data
  Building file context...
  Running safety check...
  Calling tutor API...
❌ [tutor] Request failed with status code 400
```

兩個獨立但疊加的症狀：

1. **請求被後端以 400 拒絕**，但畫面只顯示泛用的 `Request failed with status code 400`，看不出後端到底因為什麼欄位拒絕。
2. **`.tyla/debug.log` 查不到這次失敗的任何 RESPONSE 紀錄** — 學生（使用者）因此誤以為「完全沒記錄到」。

---

## 1. 根本原因分析

### 1.1 觸發點：上一輪是「純動作」回覆,content 為空字串

debug.log 第 475-497 行,tutor log_id 192 的回覆：

```json
{
  "log_id": 192,
  "status": "done",
  "content": "",            // ← 只回了 edit_file 動作,沒有任何文字
  "actions": [ { "type": "edit_file", "path": "hw2.R", "patches": [ ... ] } ]
}
```

這對應使用者按下「直接幫我修」之後,tutor 只回傳 `edit_file` 動作、prose 為空。
此空字串被存進該 turn 的 `assistantMessage`。

### 1.2 空字串被原封不動序列化進下一輪 history

history 由 `ConversationSession.getHistory()` →
`ConversationTurn.toHistoryMessages()` 組成
（[conversation-turn.ts:67-72](../tyla/src/domain/entities/conversation-turn.ts#L67-L72)）：

```ts
toHistoryMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [
        { role: 'user', content: this.userMessage },
        { role: 'assistant', content: this.assistantMessage },   // ← 沒有過濾空字串
    ];
}
```

於是下一輪請求的 `history` 陣列出現（debug.log 第 554-557 行可見）：

```json
{ "role": "assistant", "content": "" }
```

### 1.3 後端（或其上游 LLM API）拒絕空 assistant 訊息 → 400

多數 LLM provider 對 messages 有「assistant 訊息 `content` 不可為空字串」的 schema 驗證。
帶著這個空字串 history 發出的 `Show me a histogram demo...` 請求,在後端進入 LLM 呼叫前
（或後端自身的 pydantic 驗證）即被拒,回傳 HTTP 400。

> 注意：失敗的不是 prompt 本身,而是**夾帶在 history 裡的前一輪空回覆**。
> 因此換個 prompt 也會 400，只要 history 仍含該空字串訊息。

### 1.4 為什麼 debug.log「沒記錄」這次失敗

REQUEST **有**記錄（debug.log 第 518 行）。但永遠不會有對應 RESPONSE,因為
[tutor-chat-gateway.ts:83-95](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts#L83-L95)：

```ts
const response = await axios.post<TutorChatResponse>(url, body, {
    timeout: this.timeout,
    headers,
    validateStatus: (status) => status === 200 || status === 202,   // 400 不在白名單
});
const data = response.data;
debugLog('tutor', 'RESPONSE', data);   // ← 上一行已 throw,永遠跑不到這裡
```

`validateStatus` 不接受 400 → axios 直接 throw `AxiosError`。
`debugLog('tutor', 'RESPONSE', ...)` 在 throw 之後,從未執行 → debug.log 沒有 RESPONSE。

### 1.5 為什麼畫面只有泛用訊息

[execute-tutor-use-case.ts:342-346](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L342-L346)：

```ts
private failTutor(phase: 'guard' | 'tutor', error: unknown): never {
    this.deps.emit('phase_end', { phase, success: false });
    this.deps.emit('error', { message: error instanceof Error ? error.message : String(error), phase });
    throw error;
}
```

只取 `error.message`（即 axios 的泛用字串 `Request failed with status code 400`），
完全沒讀 `error.response?.data` —— 後端真正回傳的錯誤主體（很可能是
「assistant content 不可為空」這類訊息）就此被吞掉,既沒寫進 debug.log,也沒顯示給使用者。

---

## 2. 證據清單

| 證據 | 說明 |
|------|------|
| debug.log L475-497 tutor log_id 192 `content: ""` | 前一輪 tutor 純動作回覆,prose 為空 |
| debug.log L554-557 `{ "role": "assistant", "content": "" }` | 空字串被序列化進下一輪 history |
| debug.log L518 有 `[tutor] REQUEST`、其後無 `[tutor] RESPONSE` | 400 在 `validateStatus` 處 throw,RESPONSE 紀錄被跳過 |
| `tutor-chat-gateway.ts:89` `validateStatus: status === 200 \|\| 202` | 400 視為失敗 → axios throw,debugLog RESPONSE 不執行 |
| `execute-tutor-use-case.ts:344` 只取 `error.message` | `error.response?.data` 從未被讀取或記錄 |

---

## 3. 修正方案

### 3.1 防止再發生 — `toHistoryMessages()` 對空 assistantMessage 防呆

**位置**：[conversation-turn.ts:67-72](../tyla/src/domain/entities/conversation-turn.ts#L67-L72)

兩種可選作法,擇一：

**方案 A（推薦）：補佔位字串**
保留 turn 在 history 中的 user/assistant 配對結構,但把空字串換成有意義的佔位文字：

```ts
toHistoryMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [
        { role: 'user', content: this.userMessage },
        {
            role: 'assistant',
            content: this.assistantMessage.trim() === ''
                ? '(no message — file edit applied)'
                : this.assistantMessage,
        },
    ];
}
```

- 優點：history 仍維持嚴格 user/assistant 交替,不破壞任何依賴配對的下游邏輯；
  且佔位文字保留「上一輪做了 edit」的語意脈絡。
- 缺點：多送幾個 token（可忽略）。

**方案 B：略過空 assistant 訊息**

```ts
toHistoryMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [
        { role: 'user', content: this.userMessage },
    ];
    if (this.assistantMessage.trim() !== '') {
        msgs.push({ role: 'assistant', content: this.assistantMessage });
    }
    return msgs;
}
```

- 缺點：會產生連續兩個 user 訊息（本輪 user 之前一輪 user 無 assistant 夾隔），
  部分 provider 同樣不接受「連續 user 訊息」→ 可能只是把 400 從一種換成另一種。
- 因此**採方案 A**,風險最低。

> 註：`session_turns`（Option C）走後端自有的 serializer,空 prose 對 backend
> 來說是合法的（它有 actions）。本修正只針對前端 `history` 欄位這一相容路徑。

### 3.2 讓以後的 400 可被診斷 — gateway 記錄 AxiosError response body

**位置**：
[tutor-chat-gateway.ts:83-95](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts#L83-L95)、
[guard-check-gateway.ts:67-81](../tyla/src/infrastructure/api/guard/guard-check-gateway.ts#L67-L81)

在 `axios.post` 外包一層 try/catch,把 `error.response`（status + data）寫進 debug.log,
並重新 throw 一個帶後端細節的錯誤：

```ts
import axios, { isAxiosError } from 'axios';

try {
    const response = await axios.post<TutorChatResponse>(url, body, {
        timeout: this.timeout,
        headers,
        validateStatus: (status) => status === 200 || status === 202,
    });
    // …既有 success 流程不變…
} catch (error) {
    if (isAxiosError(error) && error.response) {
        debugLog('tutor', 'RESPONSE', {
            httpStatus: error.response.status,
            body: error.response.data,        // ← 後端真正的錯誤主體
        });
        // 讓 message 帶上後端細節,而非只有 axios 泛用字串
        const detail = typeof error.response.data === 'string'
            ? error.response.data
            : JSON.stringify(error.response.data);
        throw new Error(`tutor API ${error.response.status}: ${detail}`);
    }
    throw error;   // 連線/timeout 等非 HTTP 錯誤原樣拋出
}
```

guard gateway 比照辦理（tag 改 `'guard'`）。

### 3.3 `failTutor` 訊息一併帶上後端細節

§3.2 已在 gateway 層把後端細節塞進 `error.message`,
[execute-tutor-use-case.ts:342-346](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L342-L346)
的 `failTutor` 不需大改即可顯示更有用的訊息。若要更穩健,可在此處再判斷一次
`isAxiosError` 取 `error.response?.data` 作為 fallback,確保不論錯誤從哪層冒出都帶細節。

---

## 4. 測試策略

### 4.1 `conversation-turn` 單元測試

| 測試 | 覆蓋點 |
|------|--------|
| `toHistoryMessages: 空 assistantMessage → assistant content 為佔位字串而非 ''` | §3.1 方案 A |
| `toHistoryMessages: 非空 assistantMessage → 原樣輸出` | 不回歸既有行為 |
| `toHistoryMessages: 純空白 assistantMessage（'  '）也被視為空` | `.trim()` 邊界 |

### 4.2 gateway 單元測試（mock axios throw 400）

| 測試 | 覆蓋點 |
|------|--------|
| tutor gateway: axios reject `AxiosError(response.status=400, data={detail})` → `debugLog` 被呼叫且含 body；throw 的 message 含 `400` 與 detail | §3.2 |
| guard gateway: 同上 | §3.2 |
| gateway: 非 HTTP 錯誤（如 timeout / `ECONNREFUSED`）→ 原樣 throw,不吞 | 確認只攔截 `error.response` 存在的情況 |

### 4.3 驗收條件

- 重現原情境（先讓 tutor 回一次空 prose 動作,再送任意 prompt）：
  - history 中不再出現 `{ "role": "assistant", "content": "" }`
  - 該後續請求**不再 400**
- 人為構造 400（例如暫時送壞 payload）：
  - `.tyla/debug.log` 出現帶 `httpStatus` 與後端 `body` 的 `[tutor] RESPONSE` 紀錄
  - TUI 的 `❌` 訊息含後端回傳的具體原因,而非僅 `Request failed with status code 400`

---

## 5. 範圍與風險

| 項目 | 評估 |
|------|------|
| 影響範圍 | history 序列化（§3.1）僅改空字串案例；gateway（§3.2）僅新增 catch 分支,success path 不變 |
| 向後相容 | 佔位字串只影響送往後端的 history 文字,不改 session JSON 持久化格式 |
| `session_turns` 路徑 | 不受影響（後端自有 serializer,空 prose 合法） |
| 潛在風險 | 若後端對佔位字串內容有特殊解析（不太可能）需確認；debugLog 仍受 `DEBUG=1/true` 開關控制,未開時不額外寫檔 |
| 安全性 | `error.response.data` 可能含後端內部訊息;僅寫入本機 `.tyla/debug.log`、僅在 `DEBUG` 開啟時,不外送 |

---

## 6. 完成標準

- [ ] `toHistoryMessages()` 對空/純空白 assistantMessage 回傳佔位字串（§3.1 方案 A）
- [ ] tutor / guard gateway catch `AxiosError`,將 `status + response.data` 寫入 debug.log,並 throw 含細節的 message（§3.2）
- [ ] `failTutor`／錯誤事件向使用者顯示後端細節而非泛用字串（§3.3）
- [ ] `bun run build` 編譯通過（無 TypeScript 錯誤）
- [ ] `bun run test` 全綠,含 §4.1 / §4.2 新測試
- [ ] 手動驗證 §4.3 兩項驗收條件
