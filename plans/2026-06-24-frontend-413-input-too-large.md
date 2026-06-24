# 前端 track (D)：413 `input_too_large` 分流顯示

**Date:** 2026-06-24
**Status:** 待實作
**對應後端 plan：** `Tyla-api/plans/2026-06-24-provider-413-input-too-large.md`（後端已全數完成）

---

## 背景摘要

後端已把 provider 413（`tokens_limit_reached`）從 502 拆出來，回 **HTTP 413 + body**：

```json
{
  "status": "payload_too_large",
  "errors": {
    "limit_scope": "per_request",
    "limit_dimension": "tokens",
    "max_input_tokens": 8000
  }
}
```

前端目前對 413 的處理：catch block 在 `status === 413` 時走 line 127–130 的泛用 `throw new Error(...)` 路徑，變成 `result.status === 'error'`，顯示 `Tutor call failed: ...`。
需要把它分流成專屬提示「輸入太長 → 開新對話」，並嚴格與 429（稍候）分開。

---

## 鐵則（來自後端 plan §2）

| 錯誤 | HTTP | 引導動作 | 永不做 |
|---|---|---|---|
| `input_too_large` (413) | 413 | **開新對話** | 自動重打、與 429 共用路徑 |
| `rate_limited` (429) | 429 | **稍候退避** | 開新對話 |

---

## 改動範圍：兩個檔案

### 檔案 1：[tutor-chat-gateway.ts](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts)

**位置：** `tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts`

#### 1a. 擴充 `TutorChatResult` 型別（line 32–39）

在現有 `rate_limited` variant 之後，加入 `input_too_large`：

```typescript
// 現有（line 39）：
| { status: 'rate_limited'; retryAfterSeconds: number | null; limitDimension: 'requests' | 'tokens' | 'unknown' };

// 新增（接在後面）：
// 413 from the backend (provider per-request token cap; plan 2026-06-24 D).
// Never retry — same body will always re-trigger 413.
// maxInputTokens is null when the backend omitted it (pre-flight context_overflow path).
| { status: 'input_too_large'; maxInputTokens: number | null };
```

#### 1b. 在 catch block 加 413 分支（lines 115–124 後面、line 127 前面）

現有 429 分支（line 115）後緊接著加：

```typescript
// 413: input too large (per-request token cap). Return structured result so
// the use case can show "start a new conversation" — never retry (plan D).
if (error.response.status === 413) {
    const body = error.response.data as {
        errors?: { max_input_tokens?: number };
    };
    const maxInputTokens = body?.errors?.max_input_tokens ?? null;
    return { status: 'input_too_large' as const, maxInputTokens };
}
```

---

### 檔案 2：[execute-tutor-use-case.ts](../tyla/src/application/use-cases/execute-tutor-use-case.ts)

**位置：** `tyla/src/application/use-cases/execute-tutor-use-case.ts`

#### 2a. 在 `rate_limited` 分支後加 `input_too_large` 分支（lines 294–306 之後）

```typescript
// Hard 413 (plan 2026-06-24 D): input exceeds the provider's per-request token
// cap. Guide the student to start a new conversation — DO NOT retry (same body
// always re-triggers 413). OPPOSITE action from 429 (back-off & retry).
if (result.status === 'input_too_large') {
    const limitMsg = result.maxInputTokens != null
        ? `This input is too long for the provider (limit: ${result.maxInputTokens} tokens). Please start a new conversation.`
        : 'This input is too long for the provider. Please start a new conversation.';
    this.deps.emit('phase_end', { phase: 'tutor', success: false });
    this.deps.emit('error', { message: limitMsg, phase: 'tutor' });
    return { content: '', usage, apiLogs };
}
```

**位置：** 緊接在 `rate_limited` block 結束後（目前 line 306 的 `usage = addUsage(...)` 前）

---

## 中文文案選項

後端 plan §5 要求文案帶數字（有 N 時）且「開新對話」方向。建議：

| 情況 | 建議文案 |
|---|---|
| 有 N | `這次輸入太長（上限 {N} tokens），請開新對話再試。` |
| 無 N | `這次輸入太長，請開新對話再試。` |

目前 TUI 顯示的是英文（所有 error 訊息都是 inline 英文）；若日後統一國際化再改文案語言。
**本 track 先用英文保持一致：** `This input is too long for the provider (limit: N tokens). Please start a new conversation.`

---

## 執行順序

1. **改 `tutor-chat-gateway.ts`**（型別 + catch 分支）
2. **改 `execute-tutor-use-case.ts`**（消費新 status）
3. TypeScript 型別檢查：`cd tyla && bun run build`（TutorChatResult 加了新 variant 後，use case 若有 exhaustiveness check 會報錯，確認補齊）
4. 手動驗收：後端打一發 413（或 mock），確認 TUI 顯示「too long → new conversation」而非「Tutor call failed」

---

## 不需改的地方

- **TUI ChatHistory 元件**：`error` 事件已有紅色 ❌ 顯示（`ChatHistory.tsx` line 37, 51），無需新增 message type。
- **AppController**：error 事件已有對應路徑。
- **`BACKEND_WARNING_MESSAGES`**：413 是 hard failure（走 `error` event），不是 `status_update` warning，不放進此 map。
- **`session_limit_reached` 文案**：它是軟警告（`status_update`），413 是硬失敗（`error`），不共用同一條 emit 路徑（雖然引導動作相同都是「開新對話」）。

---

## 落地檢查清單

- [ ] `TutorChatResult` 加 `input_too_large` variant（gateway line 39 後）
- [ ] catch block 加 413 分支（429 分支之後、泛用 throw 之前）
- [ ] use case 加 `input_too_large` 分支（rate_limited 分支之後）
- [ ] `bun run build` 通過（無型別錯誤）
- [ ] `bun run test` 全綠（現有測試不受影響）
- [ ] 手動確認：413 回應 → TUI 顯示「too long...start a new conversation」
- [ ] 手動確認：429 路徑不受影響（仍顯示「wait...seconds before retrying」）
