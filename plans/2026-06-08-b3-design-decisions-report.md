# B3 續傳驅動器 — 功能改動特別決策點與教授報告

**日期：** 2026-06-08
**Commit 範圍：** `3f22597` → `9faca46`（共 6 個功能 commit）
**視角：** 資深軟體工程師 code review 角度

---

## 一、背景與功能目標

**B3 任務定義：** 讓 tutor AI 在回覆中要求「載入更多檔案」（`load_file` action）時，前端能**自動**把該檔案讀入 `file_context` 並重送 API，無需使用者手動操作。這是「自適應上下文擴充」能力，對課程助教 AI 的效果關鍵。

**改動涉及的核心檔案：**

| 檔案 | 類型 |
|---|---|
| `src/domain/policies/path-confinement.ts` | 新增 |
| `src/domain/policies/text-content-policy.ts` | 新增 |
| `src/application/services/file-context-budget.ts` | 新增 |
| `src/application/services/continuation-file-loader.ts` | 新增 |
| `src/domain/types/file-system.ts` | 修改（加 `realpath`） |
| `src/infrastructure/filesystem/local-file-system.ts` | 修改（加 `realpath`） |
| `src/application/services/file-read-service.ts` | 修改（改用 PathConfinement） |
| `src/application/use-cases/execute-tutor-use-case.ts` | 修改（主流程改寫） |

---

## 二、特別決策點

### 決策 1：安全邊界共用 PathConfinement Primitive（Gap A — Blocking）

**問題根源：** 原本 `FileReadService` 使用 `path.resolve(filePath)`，這是對 `process.cwd()` 解析，而非 workspace root（= `this.deps.directory`）。當使用者以 `tyla --directory ./sub` 從父目錄啟動時，兩者不相等。LLM 給的相對路徑 `hw.R` 會解析為 `cwd/hw.R` 而非 `directory/hw.R`，是既有 bug；B3 的自動迴圈會放大此問題。

**決策：** 抽出 `PathConfinement` primitive，**所有讀取路徑（ask / ReAct / B3）共用同一個安全邊界，但各自保有自己的預算政策**：

```
安全政策（confinement）= 共用 → PathConfinement primitive
預算政策（cap）= 各自 → ask/ReAct 保留 100k 字元；B3 用 token 計量
```

**演算法（path-confinement.ts:55-102）：**
1. 先拒絕任何絕對路徑（POSIX `/`、Windows `C:\`、UNC `\\server\`、`\\?\`）— 在碰 fs 之前
2. `realpath(root)` → `path.resolve(canonicalRoot, trimmed)` → `realpath(target)`
3. `path.relative(canonicalRoot, canonicalTarget)` 若以 `..` 開頭或本身是絕對路徑 → 拒絕

**為何用 `path.relative` 判斷而非字串比對 `..`：** 字串比對原始輸入無法防禦 `./../../etc` 或 symlink 迴圈等繞過；對 **canonical 結果**做相對路徑判斷才是唯一逃脫免疫的做法。

**為何不把 B3 的讀取整合進 `FileReadService`：** B3 需要 buffer-level binary 嗅探（`FileReadService` 讀 lossy UTF-8，不適合做二進位判斷）、PDF 文字抽取、token 計量 cap — 強行合併會肥大化共用服務，並把 ask 管道耦合到 B3 的 8K 預算。共用的單位是安全 primitive，不是整個 read flow。

**此決策解決的兩條 bug path：**
- `FileReadService`（ReAct `file_read` tool）cwd-relative，B3 自動迴圈同路徑 → 兩條一起收斂
- B3 `dispatchLoadFile` 傳 LLM 給的相對路徑 → 原本就是壞的

---

### 決策 2：`IFileSystem` 加入 `realpath`（Gap B — Blocking 前置）

**問題：** Clean Architecture 規定只有 `LocalFileSystem` 能 `import fs`。`PathConfinement` 需要 `fs.realpathSync`，若直接 import 就破壞架構邊界，且 symlink / 路徑收斂的單元測試無法在無 I/O 環境中執行。

**決策：** 在 `IFileSystem` 介面加 `realpath(p: string): string`，`PathConfinement` 透過注入的 interface 呼叫；`LocalFileSystem` 包裝 `fs.realpathSync`。

**好處：**
- 測試可注入 mock fs，完整模擬 symlink 跳脫情境而不碰真實磁碟
- 維持 Clean Architecture：domain / application 層永遠不碰 `fs`

**落地位置：** `file-system.ts:39`、`local-file-system.ts:43`（commit `3f22597`）

---

### 決策 3：FileContextBudget — 預算毒源在迴圈之前（Gap C — 被低估的既有風險）

**問題根源：** 計畫原本把 `file_context` 預算溢出歸因於「迴圈把 context 養大」，但毒源在**迴圈開始前就存在**：`readFallbackFiles` 最多讀 5 個原始碼檔，每檔 cap 是 `MAX_FILE_CONTENT_CHARS = 100_000`（≈ 25k tokens）。光是 base context 就可能是後端 8K 預算的數倍，第 0 圈就觸發 whole-or-drop，從未進入迴圈。

**決策：** 新增 `FileContextBudget` — 一個**每回合可變的 token 池**，常數如下：

```typescript
const PER_FILE_TOKEN_CAP = 1_200;              // 單檔上限，避免單檔獨佔 pool
const PER_TURN_FILE_CONTEXT_TOKEN_CAP = 2_200; // 整輪 base + loaded 合計
```

**關鍵設計：**
- 一個 `budget` instance 在 base 讀檔 + B3 continuation 載入**共享**，保證整輪合計不超限
- 超量時以 `skipMarker(label)` 顯式告知（`[skipped: file-context token budget exhausted]`），**不靜默 drop**；LLM 看得到 context 為何中斷
- 截斷帶 `[…truncated for token budget]` 標記，告知 LLM 內容不完整
- Token 估算用 `slice(cap * 4)`（英文 / R source 約 4 chars/token）做截斷，draw-down 時再用 `estimateTokens` 重量，在 CJK 文字時保持準確

**`readFallbackFiles` 改為循序而非 `Promise.all`：** 確保 budget draw-down 是 deterministic 的——先列到的檔案先扣預算，後列到的才被拒絕，不因 race condition 讓不同的檔案被隨機丟棄（gap-list §C 明確要求）。

---

### 決策 4：B3 迴圈控制流不變式（Gap E — 落地細節）

**迴圈結構（execute-tutor-use-case.ts:166-222）：**

```typescript
for (let i = 0; ; i++) {
    fileContext = baseContext + loadedBlocks       // 每圈重組，不累積中間回覆
    result = await tutorGateway.send(instruction, history, guard.logId, fileContext)
    usage = addUsage(usage, toTurnUsage(result.usage))  // 每圈累加

    if (i < MAX_CONTINUATIONS && 有新 load_file) {
        → 解析 + 加入 loadedBlocks → continue
    }
    // Terminal turn: dispatch（排除 load_file）
}
```

**四個關鍵不變式：**

| 不變式 | 實作位置 | 原因 |
|---|---|---|
| `instruction` / `history` 每圈不變 | 迴圈外宣告，loop 內不 mutate | guard 的 `logId` 是對原始 instruction + history 的憑證，重傳需 match；否則後端 `derive_verdict` 會 prompt mismatch |
| `usage` 每圈累加 | loop 內 `addUsage()` | 統計整輪真實 token 消耗 |
| 終端 dispatch 過濾 `load_file` | `filter(a => a.type !== 'load_file')` | `load_file` 是給 driver 的控制指令，不是前端可執行的 action |
| `MAX_CONTINUATIONS = 3` 硬上限 | `i < MAX_CONTINUATIONS` guard + emit warning | 防無限迴圈；超限時 emit `status_update` marker，計畫收斂後降至 2 |

**去重機制（resolved Map）：** key 用 canonical path（成功）或 `unresolved:<reason>:<requested>`（失敗）。同一個失敗路徑多次出現直接略過，不再向 LLM 回報，對應 b3 §4.10 risk 1（model 重複要求同一個失敗檔案）。

---

### 決策 5：ContinuationFileLoader — B3 載入的單一真實來源（Gap D 實作）

`ContinuationFileLoader` 是 B3 continuation 載入的**唯一路徑**，順序固定不可跳過：

```
PathConfinement → budget exhausted check → readBuffer
    → PDF? → size pre-filter → extractPdf → budget.take
    → Text? → isProbablyText sniff → budget.take
    → Binary → marker
```

**為何在 buffer 上做 binary 嗅探而非在 `read()` 後：** `FileReadService.read()` 用 `readFileSync(p, 'utf8')`，Node.js 會把 binary byte 替換成替代字元（U+FFFD）而不 throw，嗅探時看到的是「被污染的 UTF-8」，失效。故 `ContinuationFileLoader` 先用 `readBuffer()` 取原始 Buffer，再由 `isProbablyText()` 做 buffer-level 嗅探。

**`isProbablyText` 演算法（text-content-policy.ts）：**
- 規則 1：NUL byte（`0x00`）→ 立即回 `false`（binary magic bytes 幾乎都含 NUL）
- 規則 2：前 8000 bytes 中，非文字控制字元（不含 `\t\n\r`）佔比 > 30% → binary
- 只嗅探前 `SNIFF_BYTES = 8_000` bytes 即可；binary magic bytes 都在檔首

**PDF 處理順序（為何先 PathConfinement 再 extractPdf）：**
1. PathConfinement 確認邊界（安全在一切 I/O 之前）
2. budget exhausted check（避免浪費 PDF 解析資源）
3. readBuffer + `MAX_PDF_BYTES = 5MB` 大小 pre-filter
4. extractPdf → 得到純文字
5. `budget.take()` 施加 token cap

PDF 的 100k cap 改由 `FileContextBudget` 統一管理，不依賴 `pdf-read-tool.ts` 內建舊 cap，避免雙重 cap 設定分散、兩者不一致。

---

### 決策 6：`LoadResolution.key` 設計 — 失敗也可去重

```typescript
// 成功 → canonical path (唯一)
key = c.canonicalPath;

// 失敗 → unresolved:<reason>:<requested>
key = `unresolved:${c.reason}:${requested.trim()}`;
```

**設計意圖：** 失敗的路徑（confinement escape、not-found）無法取得 canonical path，但同一個 bad request 多次出現仍要去重。加 `<reason>` 前綴避免不同失敗原因的 key 碰撞（`empty` vs `escape` 對不同路徑），同時讓 key 人可讀，利於測試斷言。

---

## 三、架構層次圖（決策關係）

```
Clean Architecture 邊界
┌─ Domain ──────────────────────────────────────────────────────┐
│  IFileSystem          (interface + realpath)                  │
│  PathConfinement      (安全政策，所有讀取路徑共用)            │
│  TextContentPolicy    (isProbablyText，純函式，無 I/O)        │
└───────────────────────────────────────────────────────────────┘
      ↑ 依賴方向向內
┌─ Application ─────────────────────────────────────────────────┐
│  FileContextBudget      (預算政策，per-turn，per-caller 各自) │
│  ContinuationFileLoader (B3 載入唯一路徑，G7+G8+G10)         │
│  FileReadService        (ask/ReAct 讀取，改用 PathConfinement)│
│  ExecuteTutorUseCase    (B3 迴圈主控，Option B pipeline)      │
└───────────────────────────────────────────────────────────────┘
      ↑ 依賴方向向內
┌─ Infrastructure ──────────────────────────────────────────────┐
│  LocalFileSystem   (唯一 import fs 的地方)                    │
│  TutorChatGateway / GuardCheckGateway                         │
└───────────────────────────────────────────────────────────────┘
```

---

## 四、Commit 對應

| Commit | 內容 | 對應 Gap |
|---|---|---|
| `3f22597` | `IFileSystem.realpath` + `LocalFileSystem` 實作 | B |
| `bfe68cd` | `PathConfinement` primitive + 單元測試 | A |
| `3e3dc88` | `FileContextBudget` + base 讀檔 cap 收斂 | C |
| `69dbdbc` | `ContinuationFileLoader` + `TextContentPolicy`（B3 Steps 1–2） | D |
| `9faca46` | B3 continuation loop（Steps 4–6，迴圈主控） | E |

---

## 五、尚未完成的事項（follow-up）

| 代號 | 項目 | 說明 |
|---|---|---|
| D（部分） | base `readFiles` 中 PDF 仍走 `pdf_read` tool（含舊 100k cap） | base 讀檔與 B3 載入的 PDF 路徑尚未統一 |
| E | 迴圈中間圈 prose 目前靜默，未 emit `continuation` 詳細事件 | UX 決策；demo / 論文敘事可能需要 |
| F | 測試簽章漂移（test 傳兩個 constructor arg，實際只收一個） | vitest/esbuild 不型別檢查才未爆，需對齊 |
| F | Token `/4` 估算對程式碼會低估 | Phase 0 校準後調整 cap 常數 |

---

## 六、核心論點（報告摘要句）

> B3 的關鍵設計選擇是**把安全政策（confinement）與預算政策（cap）解耦**：所有讀取路徑（ask / ReAct / B3）共用同一個 `PathConfinement` primitive，保證邊界行為一致且可集中測試；各自保有不同的 token 上限，使 B3 能用比 ask 更嚴格的 8K 預算管控後端成本，兩者不相互干擾。這個「共用安全邊界 + 獨立預算政策」的設計，是整個 B3 前置工作最值得報告的架構判斷。
