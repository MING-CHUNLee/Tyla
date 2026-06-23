# Frontend Context Optimization — Implementation Plan（codebase 對帳版）

**Date:** 2026-06-06
**Status:** 待討論（companion 給設計提案 [`2026-06-06-frontend-context-optimization.md`](./2026-06-06-frontend-context-optimization.md)）
**前提:** 我把設計提案的 F1–F4 逐條對到**現在的 HEAD 程式碼**與**後端 source**，
有三點需要先更新認知，再進實作。

---

## 0. 結論先講

設計提案的方向（前端在源頭收斂 `file_context`）是對的，且**後端計畫明文要求前端先做**
（`Tyla-api/.../2026-06-06-prompt-compression-mechanism.md` §7「前端先行依賴」）。但提案的
**F2 敘述與今天剛 merge 的 commit `e72fc95` 直接衝突**，必須先把這件事講清楚再動手：

> **`e72fc95 refactor(tutor): move file context budget enforcement to backend`（今天 11:27）
> 把前端的 token cap 整段移除了。** F2 說「Step 4 那個 guard 從沒實作」是不準的——
> 它**實作過**（`truncateToTokenBudget` + `MAX_CONTEXT_TOKENS = 6_000`），**今天才被刪掉**。

---

## 決策結果（2026-06-06 拍板）

| 決策 | 拍板 | 對本案的影響 |
|---|---|---|
| **A — e72fc95 / 前端 cap** | **維持現狀，等後端加截斷**（不在前端重加 cap） | **F2 不做。** 前端依賴後端之後在 `BudgetAwarePromptAssembler` 對 file_context 加 **partial-truncate**（目前後端 source 只有 whole-or-drop，§1.2）。**這是一個 coordination 前置依賴 + 風險窗，見 §0.1。** |
| **C — F3** | **完整納入本案** | 做 cross-turn `pendingLoads` 併入下一回合 `file_context`（§3 F3 完整版）。 |
| **F1 / F4** | 照做 | F1 在決策 A 下**更重要**（§0.1）；F4 一行搬移、零風險。 |

### 0.1 ⚠️ 決策 A + C 合起來的風險（必須讓後端知道）

決策 A 把 cap 交給後端、決策 C 又讓 F3 **把更多檔案併進 file_context**。在
**後端 partial-truncate 還沒上線之前**，現況是 whole-or-drop（§1.2），於是：

> **F3（變大）+ 無前端 cap（F2 不做）+ 後端只會 whole-or-drop = file_context 整塊被丟掉的
> 機率更高 → tutor 這回合看不到任何程式碼。** 這是一個**真實的 regression 風險窗**，
> 持續到後端 partial-truncate 落地為止。

兩個務實的緩衝（建議至少採一個，避免風險窗期間 production 退化）：

1. **F1 必做且優先**：F1 收緊選檔，是目前唯一能壓住 file_context 大小的槓桿。在
   「後端會截斷」的世界裡 F1 **更重要**——因為截斷是機械式切尾，**精準選檔決定哪些內容
   活下來**；over-read 會讓真正相關的檔案被切掉。
2. **F3 併入時至少保留「單檔上限」紀律**：即使 F2 的全域 cap 不做，F3 把 `pendingLoads`
   併入時仍應對**單一大檔**做基本截斷（PER_FILE，§3 F2 的第一段），否則一個大檔就足以
   觸發後端 whole-drop。這不違反決策 A（不是全域 budget cap，只是防單檔爆量）。

→ **給後端的明確請求**：請在 `BudgetAwarePromptAssembler` 對 file_context 補
**partial-truncate（截斷到 remaining，而非整塊丟）**，並回報落地時程。在那之前，前端靠
F1 + F3 單檔紀律把風險壓低，但無法完全消除整塊丟的情形。

---

## 1. Codebase 對帳（哪些和提案不一樣）

### 1.1 🔴 修正：F2「從沒實作」不正確——cap 是今天被刪的

`e72fc95` 對 [`execute-tutor-use-case.ts`](../tyla/src/application/use-cases/execute-tutor-use-case.ts)
做了這些刪除：

```diff
-import { estimateTokens } from '../prompts';
-const MAX_CONTEXT_TOKENS = 6_000;
   ...
-  // Cap file context so the backend never receives an oversized payload.
-  return this.truncateToTokenBudget(parts.join('\n\n'), MAX_CONTEXT_TOKENS);
-}
-private truncateToTokenBudget(text: string, budget: number): string {
-  if (estimateTokens(text) <= budget) return text;
-  return text.slice(0, budget * 4) + '\n[…truncated]';
-}
+  return parts.join('\n\n');
```

而且同一個 commit 還把 `readFallbackFiles` 的**逐檔 early-stop budget guard**也拿掉，
改成 `Promise.all` 一次全讀：

```diff
-  let out = '';
-  for (const file of targets) {
-    const chunk = await this.readFiles([file]);
-    if (estimateTokens(out + chunk) > MAX_CONTEXT_TOKENS) break;
-    out += chunk;
-  }
-  return out;
+  const chunks = await Promise.all(targets.map(f => this.readFiles([f])));
+  return chunks.join('');
```

**現況（HEAD）= 前端對 `file_context` 完全沒有任何上限**。所以 F2 的「實質問題」成立，
但正確說法是：**cap 曾經存在、值設錯（6_000，是給舊 offline 路徑 budget 的）、今天被整段移除**。
不是「沒做過」。

> 為什麼 6_000 是錯的值：後端 GitHub Models hard cap 是 **8_000**，扣掉 ~5_000 靜態 base，
> `remaining` 只有 ~3_000。前端若放行 6_000 的 file_context，後端要嘛把 history 擠光、
> 要嘛（見 §1.2）整塊丟掉 file_context。**6_000 的 cap 對 8K 後端等於沒 cap。**
> `e72fc95` 拿掉它沒有讓事情變嚴重多少——但**也沒解決問題**，只是把皮球踢給後端。

### 1.2 🔴 關鍵：後端是 **whole-or-drop**，不是 truncate-to-fit（提案 §3-1 成立，且更嚴重）

直接讀後端 source [`budget_aware_prompt_assembler.rb:58-66`](../../Tyla-api/app/application/prompts/builders/budget_aware_prompt_assembler.rb)：

```ruby
if !file_context.nil? && !file_context.empty?
  fc_tokens = Values::Tokenizer.estimate(file_context)
  if fc_tokens <= remaining
    live_context = file_context          # 整塊放
    remaining   -= fc_tokens
  else
    workspace_dropped = true             # 整塊「丟」，不是截斷
  end
end
```

這就決定了「把 cap 移到後端」是**錯的分工**——因為後端**根本沒有截斷 file_context 的程式**，
它只有兩個結果：

- `fc_tokens <= remaining` → 整塊吃下去 → **history 被擠到只剩 remaining − fc_tokens**；
- `fc_tokens > remaining`  → **整塊丟掉** → 學生這回合 tutor **看不到任何程式碼**。

第二種是真正的災難情境：**F1 的 over-read（把全部 `.R` 檔串起來）很容易把 `fc_tokens`
推過 `remaining`，於是後端把整個 workspace 區塊丟掉，tutor 對著「沒有程式碼」回答。**
這比「history 被擠掉」更糟，而且是 `e72fc95` 之後前端沒 cap 才會發生。

> 結論：**前端 cap 與後端 whole-or-drop 是互補、不是重複**。前端 cap 的職責是
> 「保證 file_context 小到後端會整塊保留、且還留得下 history/summary」。這件事
> **後端做不到**（它沒有 partial-keep）。所以 cap 必須回前端。

### 1.3 ✅ 提案 §3-2 的「雙重計算」其實後端已解決（待決定 #4 可結案）

同一個 assembler，`file_context` 存在時走 `if` 分支、`student_file`（fixture）走 `else`——
**兩者互斥**（Q-B1，見檔頭註解「fixture student file is suppressed」）。所以
「前端 file_context 和後端 `StudentFileLoader` 會重複佔 token」**不會發生**。
§3-2 / 待決定 #4 可以標記為「已由後端 Q-B1 處理，無需協調」。

### 1.4 ✅ F3 的 cross-turn 狀態可行（lifecycle 已確認）

`ExecuteTutorUseCase` 在 [`agent-factory.ts:151`](../tyla/src/infrastructure/bootstrap/agent-factory.ts#L151)
**只 new 一次**，之後每回合呼叫同一個 instance 的 `execute()`。所以提案 F3 的
`private pendingLoads = new Map()` **instance field 會跨回合存活**，寫法可行。
（唯一要確認：TUI 是否每個 session 重建一次 factory——若是，instance state = session state，
正好符合提案註解「本 session」。建議實作時順手驗證。）

### 1.5 ℹ️ F1/F2 的同款 bug 也在 ask 路徑，但被 ask 自己的 end-cap 擋住

[`execute-ask-use-case.ts:104-111`](../tyla/src/application/use-cases/execute-ask-use-case.ts#L104-L111)
有**一模一樣**的副檔名 `includes(ext)` bug，且 `readRelevantFiles` 同樣無數量上限。
差別在 ask 路徑 `assembleAskPrompt()` 最後會逐段 budget 裁切，所以 over-read 被
**末端 cap 兜住**。這給我們兩個提示：

1. ask 路徑的 robustness 來自**末端 cap**，不是精準選檔——這正是 tutor 該補的（F2）。
2. `buildProjectContext` + `readRelevantFiles` 在兩個 use case 幾乎逐字重複。**是否抽共用
   helper** 列入 §4 決策（避免兩邊各修一次、各漏一次）。

---

## 2. 對帳後的問題陳述（一句話）

> `e72fc95` 把前端 cap 拿掉、交給後端，但後端對 file_context 是 **whole-or-drop（無截斷）**，
> 加上 **F1 over-read** 把 file_context 撐大——結果不是「後端幫你截斷」，而是
> **history 被擠光，甚至整個 workspace 區塊被丟掉**。修法是把 cap 收回前端，
> 但用**對 8K 後端校準過的值（~2_200，不是舊的 6_000）**，並同時收緊 F1 的選檔。

---

## 3. 各項修法（concrete diff 級）

> 順序建議：**Phase 0（量測）→ F4（一行，零風險）→ F1 + F2（核心，一起）→ F3（獨立 task）**。

### Phase 0 — 先量測（零風險，先給數據再定 cap）

在 `buildFileContext` 回傳前，把估算值記下來，對照後端回傳的 `usage.input_tokens`。
注意：現有 `debugLog(tag, direction, payload)` 的 `direction` 只接受 `'REQUEST' | 'RESPONSE'`
（[`debug-log.ts:8`](../tyla/src/infrastructure/api/shared/debug-log.ts#L8)），所以兩個選項：

- **A（最小）**：直接 `this.deps.emit('status_update', { info: \`file_context ≈ ${estimateTokens(text)} tok\` })`；
- **B**：把 `file_context` 的估值塞進 gateway `debugLog('tutor','REQUEST', body)` 已經會印的 body 裡
  （body 已含 `file_context`，DEBUG=1 時本來就看得到），Phase 0 幾乎免改。

→ 建議用 **B**：開 `DEBUG=1` 跑幾輪真實對話，從 `.tyla/debug.log` 量「file_context 多大、
多常 > remaining」。**這步定生死數字，先做。**

### F4 — `buildFileContext` 移到 guard 之後（最小、先做）

[`execute-tutor-use-case.ts:116`](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L116)
目前在 guard（122）之前組 file_context。改成：guard 通過（非 forbidden / 非 error）之後、
tutor call 之前才組。

```diff
   // ── 1. Guard pre-call ──
   ... guard = await this.deps.guardCheckGateway.check(instruction); ...
   if (guard.status === 'forbidden') { ...; return ...; }   // ← 這裡直接 return，省掉 scan
   if (guard.status === 'error')     { ...; return ...; }
+  // ── file_context 只在確定要呼叫 tutor 時才組 ──
+  const fileContext = await this.buildFileContext(instruction);
   ...
   result = await this.deps.tutorChatGateway.send(instruction, history, guard.logId, fileContext);
```

- 效果：forbidden 學生不再付 scan + 讀檔的 I/O 與延遲。
- 副作用（可接受）：UI 的 `phase 'scan'` 會排在 `phase 'guard'` 之後——順序更合理（先安全檢查）。
- ⚠️ 和 F3 的交互：F3 要把 `pendingLoads` 併進 `buildFileContext`，移到 guard 後**不影響** F3。

### F1 — 收緊副檔名比對 + 給 relevant 分支補 cap

改 [`readRelevantFiles():340-348`](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L340-L348)：

```ts
private async readRelevantFiles(instruction: string, scannedFiles: ScannedFile[]): Promise<string> {
    const instructionLower = instruction.toLowerCase();

    // 只在指令明確提到「.r / .rmd」（點號前是非英數邊界）時才算副檔名命中，
    // 避免單字母 ext "r" 命中每一句含 r 的英文。
    const extHit = (ext: string) =>
        ext.length > 0 && new RegExp(`(^|[^a-z0-9])\\.${ext}\\b`).test(instructionLower);

    const readTargets = scannedFiles
        .filter(file => {
            const nameLower = file.name.toLowerCase();
            if (instructionLower.includes(nameLower)) return true;        // 明確檔名
            return extHit(path.extname(nameLower).slice(1));              // "the .R file"
        })
        .slice(0, FALLBACK_FILE_LIMIT);                                   // ← relevant 也設上限

    return this.readFiles(readTargets);
}
```

- 「help me fix my code」→ extHit false、無檔名 → relevant 不命中 → 落 fallback（top-5）。
- 「look at hw11.R」→ 檔名命中 `hw11.R`。
- relevant 命中 > 5 檔 → 最多 5 檔。
- ⚠️ 同一個 bug 也在 ask 路徑（§1.5）——**是否一起修 / 抽 helper 見 §4 決策 D**。

### F2 — ❌ 全域 cap 不做（決策 A），但保留 `capText` 給 F3 單檔紀律

> **依決策 A，前端不重加全域 `FILE_CONTEXT_TOKEN_CAP`**——交給後端 partial-truncate。
> 下面保留的只是 **單檔截斷 helper `capText` + `PER_FILE_TOKEN_CAP`**，給 F3 併入大檔時用
> （§0.1 緩衝 2）。`estimateTokens` 的 import 因此**仍要加回來**（`e72fc95` 刪掉了）。

若未來決策 A 翻案要再加全域 cap，forward fix 如下（**非** `git revert e72fc95`，那會還原錯的 6_000）：

```ts
import { estimateTokens } from '../prompts';

// §1.1：8K 後端，base ~5K → remaining ~3K。留住 history/summary 後 file_context ≲ ~2_200。
// Phase 0 量測後與後端 SUMMARY_TOKEN_CAP 一起定案。
const FILE_CONTEXT_TOKEN_CAP = 2_200;
const PER_FILE_TOKEN_CAP     = 1_200;   // 單檔上限，避免一個大 .Rmd 吃掉整個額度（見決策 B）

// (1) 單檔截斷：在 readFiles 串接前先 cap 每個檔
//     out += `### ${file.name}\n${this.capText(content, PER_FILE_TOKEN_CAP)}\n\n`;

// (2) 總量截斷：buildFileContext 回傳前
private capText(text: string, cap: number): string {
    if (estimateTokens(text) <= cap) return text;
    return text.slice(0, cap * 4) + '\n[…truncated for token budget]';
}
// buildFileContext 末端：
//   return this.capText(parts.join('\n\n'), FILE_CONTEXT_TOKEN_CAP);
```

- **兩段式**：先單檔（防單一大檔），再總量（防多檔加總）。`e72fc95` 之前只有總量那段。
- ⚠️ `slice(cap*4)` 是「4 chars/token」近似，對**中文為主**的內容會低估（中文 2 chars/token
  → 可能還超 cap）。R 教學內容多為 ASCII，實務無虞；若要嚴謹見決策 B。

### F3 — 把 `load_file` 接回下一回合（✅ 完整納入本案）

現在 [`dispatchLoadFile():260-265`](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L260-L265)
把檔案內容 `emit('text_output')` 印給使用者，**到不了 LLM**。對齊後端 §8-5「跨回合、前端中介」：

```ts
private pendingLoads = new Map<string, string>();   // path → content（session 內，§1.4 確認可行）

private async dispatchLoadFile(action: { path: string }): Promise<void> {
    const tool = this.deps.registry.get(action.path.toLowerCase().endsWith('.pdf') ? 'pdf_read' : 'file_read');
    if (!tool) return;
    const res = await tool.execute({ path: action.path });
    if (!res.isError) {
        this.pendingLoads.set(action.path, res.content);            // 不再 emit 給使用者當聊天輸出
        this.deps.emit('status_update', { info: `loaded ${action.path} for next turn` });
    }
}
```

`buildFileContext` 起頭把 `pendingLoads` 併入（標 `### <path>`，**每檔吃 PER_FILE 單檔截斷**——
§0.1 緩衝 2），送出後 `pendingLoads.clear()`。

> ⚠️ **觸發前提（保留紀錄）**：F3 要被觸發，得有 `load_file` action 進來。目前後端是**單次
> send_prompt、把 tool_calls 當 actions 原封回傳**，tutor 何時會發 `load_file` 取決於後端
> 是否引導（策略 D，後端 §8-5 待決定）。所以 F3 前端半段**現在就做齊**（內容回得了 LLM、
> 跨回合併入），但實際觸發頻率會隨後端策略 D 上線才上升。**在那之前 F3 不會造成傷害**
> （沒 action 就不併入），且把現在「載入內容當聊天輸出印掉」的錯誤行為一併修正。
> - 連帶清理：`dispatchLoadFile` 不再 `emit('text_output')`，避免把載入內容誤當 tutor 回覆。

---

## 4. 決策狀態

| # | 決策 | 狀態 |
|---|---|---|
| **A** | 收回 `e72fc95`（前端重加 cap）？ | ❌ **不收回**（2026-06-06 拍板）。維持現狀、等後端加 partial-truncate。F2 不做。風險窗見 §0.1。 |
| **B** | `PER_FILE_TOKEN_CAP` 的值（F3 單檔紀律用） | 🔶 **仍需定**。建議 per-file ~1_200 起手，Phase 0 量測後與後端校準。全域 cap 已隨決策 A 取消。 |
| **C** | F3 是否納入本案 | ✅ **完整納入**（2026-06-06 拍板）。cross-turn `pendingLoads`。 |
| **D** | 順手修 ask 路徑 + 抽共用 helper | 🔶 **仍需定**。傾向先只動 tutor（本案 scope），把「抽 `buildProjectContext`/`readRelevantFiles` 共用 helper + 修 ask 同款 ext bug」列 follow-up。 |
| **E** | §3-2 雙重計算 | ✅ **結案**：後端 Q-B1 已互斥處理（§1.3），無需協調。 |

> 剩下要敲的只有 **B（per-file 值）** 與 **D（要不要碰 ask / 抽 helper）**——兩個都不擋開工，
> 可以邊做邊定。

---

## 5. 測試計畫（沿用提案 §7，補上對帳後的項目）

- [ ] **F1**：`"help me fix my code"`（含 r 未提檔）→ relevant 不命中、落 fallback(top-5)。
- [ ] **F1**：`"look at hw11.R"` → 只命中 `hw11.R`。
- [ ] **F1**：relevant 命中 > 5 → 輸出最多 5 檔。
- [ ] **F2（單檔紀律）**：單檔 > PER_FILE cap → 該檔被截斷帶 `[…truncated]`（給 F3 併入大檔用）。
- [ ] **F2（單檔紀律）**：單檔 ≤ PER_FILE cap → 不截斷，行為同今天。
- [ ] **（不測）全域 cap**：依決策 A 不做，無此測試。
- [ ] **F4**：guard `forbidden` → `buildFileContext` **未被呼叫**（spy `file_scan` registry.get 沒被叫）。
- [ ] **F3**：`load_file` action → 內容不再走 `text_output`；下一回合 `buildFileContext` 含該檔且被 cap。
- [ ] **Regression**：`tutor-chat-gateway.send` 的 body 形狀不變（`file_context` 仍 request-only）。
- [ ] **修測試殘骸**：`execute-tutor-use-case.test.ts` 仍用 `new ExecuteTutorUseCase(deps, 'tutor-guide')`
      的**第二個參數已是死值**（建構子只剩一個參數，runtime 忽略）。本案會動這支測試，順手清掉。

---

## 6. 排程（依拍板決策更新）

1. **Phase 0**：DEBUG log 量測——量出 file_context 多大、多常 > backend `remaining`。
   這份數據**同時給後端**校準 partial-truncate 與 `SUMMARY_TOKEN_CAP`（決策 A 把球給了後端，
   後端需要這個數字）。
2. **F1（優先）**：收緊選檔 + relevant 分支 cap。決策 A 下這是**唯一壓住 file_context 大小的
   前端槓桿**，先上。
3. **F4**：一行搬移（`buildFileContext` → guard 之後）+ 測試。
4. **F3（完整）**：`pendingLoads` cross-turn 併入 `file_context`；併入時保留**單檔截斷紀律**
   （§0.1 緩衝 2），避免在後端 partial-truncate 上線前放大 whole-drop 風險。
5. **（不做）F2 全域 cap**：依決策 A 取消，等後端 partial-truncate。
6. **協調**：把 §0.1 的「請後端加 partial-truncate + 回報時程」送出；在那之前 §0.1 風險窗存在。

> 注意：**F2 全域 cap 取消後，本案不再「排在後端 Phase 1 之前」成為硬性前置**——但 F1 仍應
> 先行（它直接決定後端截斷時哪些內容活下來）。

---

## 7. 給後端的協調訊息

> 1. **（需要你們動手）** 我們決定 file_context budget **留在後端**——但後端目前是
>    **whole-or-drop（無截斷）**。請在 `BudgetAwarePromptAssembler` 對 file_context 補
>    **partial-truncate（截到 `remaining`，而非整塊丟）**，並回報落地時程。在那之前存在
>    §0.1 風險窗（over-read / F3 變大 → 整塊被丟 → tutor 看不到程式碼）。
> 2. 前端會做 **F1（收緊選檔）**先壓低 file_context 大小，並在 **F3** 併入時對單檔截斷，
>    把風險窗壓低；但**無法完全消除**整塊丟，partial-truncate 仍是正解。
> 3. **§3-2 雙重計算**經查 Q-B1 已互斥、無需動作。
> 4. Phase 0 量測的 file_context 大小數據會同步給你們，校準 partial-truncate 與
>    `SUMMARY_TOKEN_CAP`。
