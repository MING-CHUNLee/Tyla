# 前端 Track：Provider Rate-Limit Passthrough 實作計畫

**Date:** 2026-06-22
**Status:** 已實作（2026-06-22；§3.2 改動 B 位置經實作修正，見該節 ⚠️）
**父規格：** `Tyla-api/plans/2026-06-18-provider-rate-limit-passthrough.md` §6（前端規格段）
**背景：** 後端已完成兩批交付（C1+透傳+C3、C2 軟警告）。前端需新增兩條分流路徑，並在文案/引導行為上正確區分（§6 ⚠️ 特別強調「A 與 C 的使用者動作相反」）。

---

## 1. 現況缺口

| 缺口 | 現在行為 | 原因 |
|---|---|---|
| 429 被當一般錯誤吞掉 | `validateStatus: (s) => s === 200 \|\| s === 202` → 429 落入 axios catch → 拋 `new Error("tutor API 429: …")` → `failTutor()` → `error` event（訊息無結構、無 retry_after） | `tutor-chat-gateway.ts:91` |
| `provider_rate_limited` 無正確文案 | `BACKEND_WARNING_MESSAGES` 無此 key → fallback `"backend warning: provider_rate_limited"` | `execute-tutor-use-case.ts:48-61` |
| `session_limit_reached` 無正確文案 | 同上 → fallback | 同上 |

**缺口的影響：**
- 429 目前顯示 `[tutor] 429: {"status":"rate_limited",…}` 的 raw JSON，學生看不懂；且沒有退避引導（不顯示等幾秒）。
- `provider_rate_limited` 若後端已開始送出，會以 `backend warning: provider_rate_limited` 顯示，文案含糊且語意不對。
- `session_limit_reached` 同理（此 warning 後端已上線）。

---

## 2. 兩個訊號、兩種處理

| 訊號 | 來源 | 當前行為 | 目標行為 |
|---|---|---|---|
| **硬 429** | HTTP 429 + body `{ status: "rate_limited", errors: { retry_after, limit_scope, limit_dimension } }` | 拋 raw 錯誤訊息 | 顯示「金鑰被限流，等 N 秒再試」；**不**建議開新對話 |
| **軟 `provider_rate_limited`** | 成功回應 `warnings[]` 含此字串 | fallback 顯示 | 顯示「金鑰配額快用完」柔性提示；**不**建議開新對話 |
| **`session_limit_reached`**（補齊） | 成功回應 `warnings[]` | fallback 顯示 | 顯示「對話太長，建議開新對話」；**正相反**的引導 |

> ⚠️ **核心正確性要求（§6 鐵則）**：`session_limit_reached`（A）→ 引導「開新對話」；`provider_rate_limited` / 429（C）→ 引導「稍候重試」。兩者動作相反，文案和 handler 出口**不可共用**。

---

## 3. 逐檔改動

### 3.1 `tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts`

#### 改動：新增 `rate_limited` variant 到 `TutorChatResult`

```typescript
// 在現有 union 末尾加一條
export type TutorChatResult =
    | { status: 'done' | 'unavailable'; logId: number; content: string; actions: TutorAction[]; usage: Usage; guardSkipped: boolean; warnings: string[]; rawExchange?: TutorRawExchange }
    | { status: 'forbidden';            logId: number; content: string; usage: Usage; rawExchange?: TutorRawExchange }
    | { status: 'error';                logId: number; content: string; usage: Usage; rawExchange?: TutorRawExchange }
    | { status: 'rate_limited';         retryAfterSeconds: number | null; limitDimension: 'requests' | 'tokens' | 'unknown' };
    //  ^^ 新增 ─ 無 logId（429 body 不一定有）；無 rawExchange（錯誤路徑 debug log 已在 catch 中記）
```

#### 改動：catch 區塊識別 429，回傳結構化 result（取代拋出 generic Error）

現有 catch 區塊（`tutor-chat-gateway.ts:94-112`）：

```typescript
} catch (error) {
    if (isAxiosError(error) && error.response) {
        debugLog('tutor', 'RESPONSE', {
            httpStatus: error.response.status,
            body: error.response.data,
        });
        const detail = typeof error.response.data === 'string'
            ? error.response.data
            : JSON.stringify(error.response.data);
        throw new Error(`tutor API ${error.response.status}: ${detail}`);
    }
    throw error;
}
```

改為：

```typescript
} catch (error) {
    if (isAxiosError(error) && error.response) {
        debugLog('tutor', 'RESPONSE', {
            httpStatus: error.response.status,
            body: error.response.data,
        });

        // 429: 結構化回傳，讓 use-case 做正確的退避引導（§6）
        if (error.response.status === 429) {
            const body = error.response.data as {
                errors?: { retry_after?: string | number; limit_dimension?: string };
            };
            const ra = body?.errors?.retry_after;
            const retryAfterSeconds = ra != null ? Number(ra) : null;
            const dim = body?.errors?.limit_dimension;
            const limitDimension: 'requests' | 'tokens' | 'unknown' =
                dim === 'requests' || dim === 'tokens' ? dim : 'unknown';
            return { status: 'rate_limited' as const, retryAfterSeconds, limitDimension };
        }

        const detail = typeof error.response.data === 'string'
            ? error.response.data
            : JSON.stringify(error.response.data);
        throw new Error(`tutor API ${error.response.status}: ${detail}`);
    }
    throw error;
}
```

**不改動 `validateStatus`**（維持 `200 || 202`）。429 仍走 catch 路徑，避免讓成功路徑的型別變複雜。

### 3.2 `tyla/src/application/use-cases/execute-tutor-use-case.ts`

#### 改動 A：`BACKEND_WARNING_MESSAGES` 加兩個 key（`session_limit_reached`、`provider_rate_limited`）

在現有 `BACKEND_WARNING_MESSAGES`（`execute-tutor-use-case.ts:48-61`）末尾加：

```typescript
// plan 2026-06-16-session-token-limit-signal (A) — per-request context limit.
// Action: start a new conversation (context is cleared).
session_limit_reached:
    'This conversation is too long for the current request. Start a new conversation to continue.',

// plan 2026-06-18-provider-rate-limit-passthrough (C2) — account-level rate window.
// Action: wait for the window to reset; opening a new conversation does NOT help.
provider_rate_limited:
    'Your API key quota is running low for this period. Please wait before sending more messages.',
```

> **文案設計原則**：`session_limit_reached` 結尾導向「開新對話」；`provider_rate_limited` 結尾導向「等待」。**不互換**，見 §2 ⚠️。

#### 改動 B：continuation loop 加 `rate_limited` 分支

在 B3 continuation loop 中，**緊接在 `tutorChatGateway.send` 的 `try/catch` 之後、`usage = addUsage(usage, toTurnUsage(result.usage))` 之前**加入此分支：

```typescript
} catch (error) {
    return this.failTutor('tutor', error);
}

// ⬇️ 在這裡（usage / rawExchange 存取之前）
if (result.status === 'rate_limited') {
    const waitMsg = result.retryAfterSeconds != null
        ? `Please wait about ${result.retryAfterSeconds} seconds before retrying.`
        : 'Please wait a moment before retrying.';
    const scopeMsg = result.limitDimension === 'requests'
        ? 'Your API key has hit its per-minute request limit.'
        : result.limitDimension === 'tokens'
            ? 'Your API key has hit its per-minute token limit.'
            : 'Your API key has been rate limited by the LLM provider.';
    this.deps.emit('phase_end', { phase: 'tutor', success: false });
    this.deps.emit('error', {
        message: `${scopeMsg} ${waitMsg}`,
        phase: 'tutor',
    });
    return { content: '', usage, apiLogs };
}

usage = addUsage(usage, toTurnUsage(result.usage));
```

**注意**：
- ⚠️ **位置修正（實作時發現）**：本分支**必須**放在 `usage = addUsage(...)`（讀 `result.usage`）與 `if (result.rawExchange)`（讀 `result.rawExchange`）**之前**。`rate_limited` variant 依 §3.1 設計**不帶** `usage`／`rawExchange`，一旦加入 union，這兩處對未收斂 union 的屬性存取會觸發 **TS2339 編譯錯誤**（`tsup`/esbuild 不做型別檢查，不會擋下；需 `tsc --noEmit` 才能驗出）。把 early-return 提前到此處可讓 TS 將 `result` 收斂為其餘 variant，後續存取才合法。原規劃寫「在 `forbidden` 判斷之前」不足以滿足此點。
- 用現有 `error` event（非新 event 型別），不需動 `agent-service.ts` 或 `event-mapper.ts`。
- `return { content: '', usage, apiLogs }` 終止 loop，**不重試**（見 §4「不做的事」）。`usage` 此時僅含 guard 階段用量（429 body 無 usage）。
- 不用 `failTutor()`（那個會 `throw`，讓呼叫端也拋錯）。

---

## 4. 不做的事（與理由）

| 項目 | 理由 |
|---|---|
| **自動退避重試**（等 N 秒後自動重打）| CLI/TUI 內實作 countdown + 自動重試複雜度高；使用者在等待期間可切換任務，手動重試更符合 CLI 互動慣例；`retry_after` 數值已顯示在錯誤訊息，手動等效果一樣 |
| **新 event 型別**（`rate_limited_error`）| 現有 `error` event 已有完整的渲染路徑（`event-mapper.ts:251-252`），訊息可攜帶 retry_after 資訊；增加新 event 型別需動 `AgentEvent` union、event-mapper switch 和測試，成本不符比例 |
| **`limit_window` 在文案分 per_minute/per_day**| C3 量測已確認 GitHub Models `renewalperiod=60`（per_minute），但 Anthropic 的 window 未知；文案統一說「this period」，不猜測 window |
| **軟路徑 dimension 後綴 token**（`provider_rate_limited_requests`/`_tokens`）| 需改 `warnings_for` + 前端 prefix-比對，受益小；第一版用單一通用 token，可 §6 §10 再升級 |

---

## 5. 不需改動的檔案

- `tyla/src/application/services/agent-service.ts` — 無新 event 型別
- `tyla/src/tui/presentation/event-mapper.ts` — `error` event 渲染路徑已有；`status_update.warning` 路徑已有
- `tyla/src/shared/i18n/` — 警告訊息沿用 hardcoded 英文字串（與其他 warning 一致）
- Guard gateway — 與 rate-limit 無關

---

## 6. 測試計畫

### 6.1 `tyla/tests/unit/infrastructure/tutor-chat-gateway.test.ts`（擴充）

```typescript
describe('429 rate limit', () => {
    it('returns rate_limited result when backend returns 429', async () => {
        mockPost.mockRejectedValue(axiosError(429, {
            status: 'rate_limited',
            errors: { retry_after: '30', limit_dimension: 'requests' },
        }));
        const gw = new TutorChatGateway();
        const result = await gw.send('hi', [], 1);
        expect(result.status).toBe('rate_limited');
        expect((result as { retryAfterSeconds: number }).retryAfterSeconds).toBe(30);
        expect((result as { limitDimension: string }).limitDimension).toBe('requests');
    });

    it('handles 429 with no retry_after', async () => {
        mockPost.mockRejectedValue(axiosError(429, { status: 'rate_limited', errors: {} }));
        const gw = new TutorChatGateway();
        const result = await gw.send('hi', [], 1);
        expect(result.status).toBe('rate_limited');
        expect((result as { retryAfterSeconds: number | null }).retryAfterSeconds).toBeNull();
        expect((result as { limitDimension: string }).limitDimension).toBe('unknown');
    });

    it('still throws for non-429 errors (e.g. 502)', async () => {
        mockPost.mockRejectedValue(axiosError(502, 'bad gateway'));
        const gw = new TutorChatGateway();
        await expect(gw.send('hi', [], 1)).rejects.toThrow('tutor API 502');
    });

    it('rate_limited result does not include log_id or content', async () => {
        mockPost.mockRejectedValue(axiosError(429, { errors: { retry_after: '10' } }));
        const gw = new TutorChatGateway();
        const result = await gw.send('hi', [], 1);
        expect(result).not.toHaveProperty('logId');
        expect(result).not.toHaveProperty('content');
    });
});
```

### 6.2 `tyla/tests/unit/application/execute-tutor-use-case.test.ts`（擴充）

```typescript
// 硬 429 → error event 含 retry_after 文案
it('emits error with retry_after when tutor returns rate_limited', async () => {
    const { deps, events } = makeOptionB({
        tutor: { status: 'rate_limited', retryAfterSeconds: 45, limitDimension: 'requests' },
    });
    await new ExecuteTutorUseCase(deps).execute('hi', []);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.data.message).toContain('45 seconds');
    expect(err!.data.message).toContain('request limit');
});

it('emits error with generic message when limitDimension is unknown', async () => {
    const { deps, events } = makeOptionB({
        tutor: { status: 'rate_limited', retryAfterSeconds: null, limitDimension: 'unknown' },
    });
    await new ExecuteTutorUseCase(deps).execute('hi', []);
    const err = events.find(e => e.type === 'error');
    expect(err!.data.message).toContain('rate limited');
    expect(err!.data.message).toContain('wait a moment');
});

// 軟 warning: provider_rate_limited → status_update warning（區分 session_limit_reached）
it('shows provider_rate_limited warning without suggesting new conversation', async () => {
    const { deps, events } = makeOptionB({
        tutor: {
            status: 'done', logId: 7, content: 'ok', actions: [],
            guardSkipped: false, usage: { inputTokens: 1, outputTokens: 1 },
            warnings: ['provider_rate_limited'],
        },
    });
    await new ExecuteTutorUseCase(deps).execute('hi', []);
    const w = events.find(e => e.type === 'status_update' && String(e.data.warning).includes('quota'));
    expect(w).toBeDefined();
    expect(String(w!.data.warning)).not.toContain('new conversation');
});

it('shows session_limit_reached warning suggesting new conversation', async () => {
    const { deps, events } = makeOptionB({
        tutor: {
            status: 'done', logId: 7, content: 'ok', actions: [],
            guardSkipped: false, usage: { inputTokens: 1, outputTokens: 1 },
            warnings: ['session_limit_reached'],
        },
    });
    await new ExecuteTutorUseCase(deps).execute('hi', []);
    const w = events.find(e => e.type === 'status_update' && String(e.data.warning).includes('new conversation'));
    expect(w).toBeDefined();
});

// 正交性：兩者同時觸發 → 各自獨立顯示
it('handles rate_limited warning and session_limit_reached simultaneously', async () => {
    const { deps, events } = makeOptionB({
        tutor: {
            status: 'done', logId: 7, content: 'ok', actions: [],
            guardSkipped: false, usage: { inputTokens: 1, outputTokens: 1 },
            warnings: ['session_limit_reached', 'provider_rate_limited'],
        },
    });
    await new ExecuteTutorUseCase(deps).execute('hi', []);
    // 注意：本地變數命名為 warningMsgs，避免遮蔽該測試檔模組層既有的 warnings() helper。
    const warningMsgs = events
        .filter(e => e.type === 'status_update' && e.data.warning)
        .map(e => e.data.warning as string);
    expect(warningMsgs.some(w => w.includes('new conversation'))).toBe(true);   // session
    expect(warningMsgs.some(w => w.includes('quota'))).toBe(true);              // provider
});
```

### 6.3 驗收

- `cd tyla && bun run test` 全綠（含新增測試）。
- 手動驗收（可模擬）：
  - 模擬 429：在 gateway mock 傳回 `{ status: 'rate_limited', retryAfterSeconds: 30, limitDimension: 'requests' }` → TUI 顯示含 "30 seconds" 的 error 訊息，**不**含「開新對話」字樣。
  - 模擬軟警告：在 mock 的 `warnings` 加 `'provider_rate_limited'` → TUI 以 `⚠` 顯示配額提示，**不**含「開新對話」字樣。
  - 模擬 `session_limit_reached` → TUI 以 `⚠` 顯示「開新對話」提示。

---

## 7. 改動摘要（最小 diff）

| 檔案 | 改動行數（估） | 改動內容 |
|---|---|---|
| `tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts` | +18 行 | `TutorChatResult` 加 `rate_limited` variant；catch 區塊加 429 分支 |
| `tyla/src/application/use-cases/execute-tutor-use-case.ts` | +16 行 | `BACKEND_WARNING_MESSAGES` 加 2 key；continuation loop 加 `rate_limited` 分支 |
| `tyla/tests/unit/infrastructure/tutor-chat-gateway.test.ts` | +30 行 | 新增 4 個 429 測試 |
| `tyla/tests/unit/application/execute-tutor-use-case.test.ts` | +50 行 | 新增 4 個 rate-limit 測試 |

---

## 8. 實作順序

1. 修改 `tutor-chat-gateway.ts` + 對應測試 → 跑 test 確認舊測試不爆。
2. 修改 `execute-tutor-use-case.ts` + 對應測試 → 跑 test 全綠。
3. 手動驗收（見 §6.3）。
