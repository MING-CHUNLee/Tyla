# B3 續傳驅動器 — Gap-List 補充（codebase 對帳版）

**Date:** 2026-06-07
**Status:** 補充章節，companion 給設計計畫
[`Tyla-api/plans/2026-06-07-b3-frontend-continuation-driver.md`](../../Tyla-api/plans/2026-06-07-b3-frontend-continuation-driver.md)
。**§A 設計決策已於 2026-06-07 拍板（共用 `PathConfinement` primitive）。**
**前提:** 以資深工程師視角把 B3 計畫的 §2~§7 逐條對到**現在的 HEAD 程式碼**，
列出計畫改動清單（§7）尚未完整涵蓋、且會在動工時踩到的縫隙。

> 本文不取代原計畫；原計畫的方向與「後端零改動」論證**成立**。本文只補「動工前必須先釘死的東西」。

---

## 0. 結論先講

原計畫對 codebase 的判讀**正確**：`load_file` 確實是死路、`callGateway()` 是唯一縫合點、
後端契約不動可成立。但有 **3 個前置缺口（A/B/C）計畫 §7 未列**，其中 A、B 是 blocking、
C 是被低估的既有風險。先把下方 checklist 做完再包迴圈，否則安全防線有破口、或迴圈接上去即壞。

| 代號 | 主題 | 嚴重度 | 計畫是否已涵蓋 |
|---|---|---|---|
| **A** | 邊界要錨定 `directory`；**決策＝共用 `PathConfinement` primitive** | 🔴 Blocking | §3.2 提到「無 realpath」，本文補 cwd≠directory + 安全/預算政策分離 |
| **B** | `IFileSystem` 沒有 `realpath` | 🔴 Blocking 前置 | §7 改動清單未列 |
| **C** | base file_context 自己就會撐爆 8K | 🟠 被低估 | §6.1 歸因於迴圈，但毒源在迴圈之前 |
| **D** | binary 嗅探順序 + PDF 先收斂再抽取 | 🟡 落地細節 | §4.1/§4.2 方向對，缺順序提醒 |
| **E** | 迴圈控制流陷阱（usage / history / 終端 dispatch / MAX 邊界） | 🟡 落地細節 | §2 偽碼對，落地時易漏 |
| **F** | 測試簽章漂移 + `mockResolvedValueOnce` 串接 | ⚪ nit | §9 未提 |

### 本期 scope（2026-06-07 收斂）

> **聚焦 A / B / C 三項前置；D / E / F 視為實作 follow-up。**

- **A / B / C ＝ 動工前必須完成的前置**（共用安全邊界 + `realpath` + base 預算）。這三項是
  B3 迴圈能安全接上的先決條件，獨立成項、先做先測。
- **D / E / F ＝ 包迴圈時自然會碰到的落地細節與測試**，在 B3 實作過程中**按需拉入**
  （unless they prove necessary during development），不另列為前置工項。

---

## 1. 前置 Checklist（A/B/C — 動工前必須完成）

### 🔴 A. 邊界必須錨定 `directory`，而非 `process.cwd()`

整個安全模型的真正核心。計畫 §3.2 只說 reader「無 realpath、無收斂」，
**漏掉更關鍵的一點**：

> [file-read-service.ts:20](../tyla/src/application/services/file-read-service.ts#L20) 的
> `path.resolve(filePath)` 是**對 `process.cwd()`** 解析，不是對 workspace root。
> 但 tutor 流程的 root 是 `this.deps.directory`
> （= [agent-factory.ts:68](../tyla/src/infrastructure/bootstrap/agent-factory.ts#L68)
> 的 `path.resolve(rawDirectory)`）。兩者**不保證相等**（CLI 從父目錄帶
> `--directory ./sub` 啟動時就不同）。

後果分兩條路徑：
- `buildFileContext` → `readFiles` 傳的是 scan 出的**絕對路徑**
  （[file-scanner.ts:80-86](../tyla/src/infrastructure/filesystem/file-scanner.ts#L80-L86)
  `absolute: true`），所以**現在**碰巧沒事。
- 但 `dispatchLoadFile` 傳的是 **LLM 給的相對路徑**（`hw.R`）→ `path.resolve('hw.R')`
  = `cwd/hw.R` ≠ `directory/hw.R`。**今天的 `load_file` 在 cwd≠directory 時就已經是壞的**，
  B3 把它接成自動迴圈只會放大這個錯。

**`FileReadService` 是共用單例。** 它在
[agent-factory.ts:81-85](../tyla/src/infrastructure/bootstrap/agent-factory.ts#L81-L85)
註冊，`file_read` tool 同時被 **ask pipeline 與 ReAct 迴圈**使用。

#### 決策（2026-06-07 拍板）：共用 `PathConfinement` primitive

> **不要**讓 B3 自帶一個獨立 helper、而 `FileReadService` 維持不收斂——那會造成
> **跨讀取路徑的 confinement 行為分歧**（ReAct `file_read` 仍 cwd-relative 且無邊界，
> B3 卻有邊界）。改為把「邊界」抽成**單一 primitive，所有讀取路徑共用**。

把原本「fold into FileReadService」綁在一起、但歸屬不同的三件事拆開：

| 關注點 | 是否通用 | 歸屬 |
|---|---|---|
| **confinement**（realpath + 邊界）＝ **安全政策** | ✅ 每條讀取路徑都一樣 | **單一共用 primitive**，到處採用 |
| **binary / text 嗅探** | ✅ 大致通用（絕不把 binary 餵進任何 LLM） | primitive 內或緊鄰 |
| **token cap** ＝ **預算政策** | ❌ B3 護的是 8K 後端預算；ask 護的是 100k 字元上限 | **caller-specific**，留在各 caller |

→ 「兩條路徑、不同安全行為」靠**統一 confinement** 解決，**不是**靠統一整個 read。
B3 與 ask 的 cap 差異是**刻意的預算政策**，非安全分歧。**把安全政策（confinement）與
預算政策（cap）分開**，是這個設計最好推理的地方。

**call-site 稽核（佐證此決策低風險）：**
- 所有**合法**讀取現在都已傳「root 內的絕對路徑」（ask
  [execute-ask-use-case.ts:120](../tyla/src/application/use-cases/execute-ask-use-case.ts#L120)、
  tutor [execute-tutor-use-case.ts:358](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L358)
  都來自 scanner 的 `absolute:true`）。唯二「LLM 指定 + 相對」的是 ReAct `file_read` tool-call
  與 B3 `dispatchLoadFile`——正是要收斂的兩條。
- **沒有** `file-read-service.test.ts`；ask / tutor 單元測試都 mock registry tool、不碰真實
  service。→ 把 confinement 收進 `FileReadService` **不會弄壞測試**，且其實是修既有 cwd
  latent bug。唯一行為變化：LLM 指定一條**跳出 workspace** 的路徑會被拒——對課程 agent 是
  想要的收緊，非 regression。

**Checklist：**
- [x] 新增 **`PathConfinement` primitive**：`resolveWithinRoot(root, requested)` →
      `{ ok: true, canonicalPath } | { ok: false, reason }`。**只做邊界 + realpath，不讀檔、不施 cap。**
      → [path-confinement.ts](../tyla/src/domain/policies/path-confinement.ts)（2026-06-07）。
- [x] primitive 內部：`realpath(root)` → `path.resolve(root, requested)` → `realpath(target)`
      → `path.relative(root, real)`；拒絕 `rel` 以 `..` 開頭或 `path.isAbsolute(rel)`。
      **用 `path.relative` 判收斂，不對原始字串比對 `..`。**
- [x] primitive 依賴注入的 `IFileSystem`（需 gap B 的 `realpath`）+ `path`，放 application/domain 層
      → 可注入 mock fs 做單元測試、且只有 `LocalFileSystem` 碰 `fs`（守 clean architecture）。
- [x] **`FileReadService` 採用 primitive**：constructor 綁入 `root`（factory 已有 `directory`），
      把 [file-read-service.ts:20](../tyla/src/application/services/file-read-service.ts#L20) 的
      `path.resolve(filePath)` 換成 `resolveWithinRoot(root, filePath)`；**保留**它原本的 100k cap
      給 ask / ReAct。
- [ ] **B3 driver 呼叫同一個 primitive**，再自行做 buffer 嗅探 + PDF 抽取 + 自己的 1.5k/3k cap
      （見 C / D）；**不**沿用 FileReadService 的 100k cap。 ← B3 follow-up，本期未做。
- [x] Windows 絕對路徑用 `path.win32.isAbsolute` 同擋 drive-letter（`C:\`）、UNC
      （`\\server\share`）、`\\?\`。
- [x] 順手修文案：[file-read-tool.ts:23](../tyla/src/application/tools/file-read-tool.ts#L23) 的
      schema「absolute or relative to cwd」→「relative to workspace root」。

**為何不把 B3 的 read 整碗 fold 進 FileReadService：** B3 需要 ask 不需要的東西——buffer-level
binary 嗅探（FileReadService 讀的是 lossy utf8）、PDF 抽取（在獨立的 `pdf_read` tool、根本不在
FileReadService 裡）、token-based cap。全推進共用 service 會肥大化、且把 ask 耦合到 B3 的 8K 預算。
**共用的單位是 `PathConfinement` primitive，不是 read flow。**

**驗收**：相對 OK／絕對拒／`..` 跳脫拒／symlink 跳脫拒／Win32 drive+UNC 拒／realpath 收斂
（`hw.R`、`./hw.R`、symlink → 同一筆）全綠；且 ask / ReAct 既有測試不變綠。

---

### 🔴 B. `IFileSystem` 沒有 `realpath` — 改動清單漏列

計畫 §3.2 的硬防線是 `fs.realpathSync`，但
[file-system.ts:9-33](../tyla/src/domain/types/file-system.ts#L9-L33) **沒有 realpath**，
且 CLAUDE.md 規定只有
[local-file-system.ts](../tyla/src/infrastructure/filesystem/local-file-system.ts)
能 import `fs`。

**決策（隨 A 一併拍板）：在 `IFileSystem` 加 `realpath`，不繞過。**
A 的 `PathConfinement` primitive 依賴注入的 `IFileSystem` 才能用 mock fs 做單元測試（§9 的
symlink / 收斂測試需要它），故 primitive **不可**自行 `import fs`。

**Checklist：**
- [x] 在 `IFileSystem` + `LocalFileSystem` 各加 `realpath(p: string): string`（包裝 `fs.realpathSync`）。
      → commit `3f22597`（[file-system.ts:39](../tyla/src/domain/types/file-system.ts#L39)、
      [local-file-system.ts:43](../tyla/src/infrastructure/filesystem/local-file-system.ts#L43)）。
- [x] `PathConfinement` 經由注入的 `IFileSystem.realpath` 收斂，不直接碰 `fs`。

**註**：[local-file-system.ts:14](../tyla/src/infrastructure/filesystem/local-file-system.ts#L14)
的 `exists` 用 `existsSync` 會**跟隨 symlink**；壞 symlink 交給 `realpathSync` throw →
當 unavailable（與 not-found 同路徑），計畫已正確處理。

---

### 🟠 C. base file_context 自己就會撐爆 8K（毒源在迴圈之前）

計畫 §6.1 把 whole-or-drop 自我中毒歸因於「迴圈把 file_context 養大」，但
**毒源在迴圈開始前就存在**：

> [readFallbackFiles](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L287-L300)
> 會自動讀**最多 5 個**原始碼檔，每檔 cap 是
> [agent-file-policy.ts:56](../tyla/src/domain/policies/agent-file-policy.ts#L56) 的
> `MAX_FILE_CONTENT_CHARS = 100_000`（≈ 每檔 25k tokens）。**光是 base context 就能是 8K
> 預算的數倍**，第 0 圈就觸發後端 whole-or-drop。

換言之：計畫對「load 進來的檔」精心設計的 per-file / per-turn cap，會被**沒有套新 cap 的
base 讀檔**整碗端走。§4.7 的自適應 `headroom − base` 方向對，但**只有當 base 本身也改用新
token cap（而非 100k）才成立**。

**Checklist：**
- [x] 新的 per-file token cap **同時套用在 base 讀檔路徑**
      （`readFiles` / `readFallbackFiles`），不要只套在續傳載入。
      → 新增 [`FileContextBudget`](../tyla/src/application/services/file-context-budget.ts)
      （`PER_FILE_TOKEN_CAP = 1_200`），由
      [execute-tutor-use-case.ts](../tyla/src/application/use-cases/execute-tutor-use-case.ts)
      的 `readFiles` 對每檔施 cap（截斷帶 `[…truncated for token budget]`）。
- [x] per-turn 總量 cap 把 base 與 loaded 合計，超量以 marker 拒絕後續載入（不靜默 drop）。
      → `buildFileContext` 每回合建一個 `FileContextBudget`
      （`PER_TURN_FILE_CONTEXT_TOKEN_CAP = 2_200`）並 thread 進 `readRelevantFiles` /
      `readFallbackFiles`（後者改回**循序**讀以保證 deterministic draw-down）；超量檔
      append `[skipped: file-context token budget exhausted]` 並 emit `status_update`。
      **loaded（B3 續傳）落地時共用同一個 budget instance 即可合計** ← B3 follow-up。
      測試：[execute-tutor-use-case.test.ts](../tyla/tests/unit/application/execute-tutor-use-case.test.ts)
      「file_context budget (§C)」三項（per-file 截斷／per-turn marker 拒絕／小檔不動）全綠。

---

## 2. 落地細節（D/E — 實作 follow-up，包迴圈時對照）

> 非前置。在 B3 迴圈實作過程中按需拉入；列在此處供動工時對照，避免遺漏。

### 🟡 D. binary 嗅探順序 + PDF 先收斂再抽取
- [ ] **NUL / UTF-8 嗅探在 buffer 上做，不能在 `read()` 之後。**
      [local-file-system.ts:18](../tyla/src/infrastructure/filesystem/local-file-system.ts#L18)
      的 `read` 是 `readFileSync(p,'utf8')`，對 binary 不 throw、只產生替代字元 → 嗅探失效。
      先 `readBuffer()`（介面已有，[file-system.ts:17](../tyla/src/domain/types/file-system.ts#L17)）
      嗅 NUL / 高比例 non-UTF8，再 decode。
- [ ] **PDF 先收斂、再抽取。**
      [pdf-read-tool.ts:42](../tyla/src/application/tools/pdf-read-tool.ts#L42) 自己也是
      `path.resolve`（cwd-relative）、內建 100k cap
      （[pdf-read-tool.ts:81](../tyla/src/application/tools/pdf-read-tool.ts#L81)）。
      driver 先用 helper 解析出 realpath 絕對路徑 → 再交給抽取
      （`path.resolve(abs)` 對絕對路徑 idempotent，`.pdf` 檢查照過）→ cap 由 driver 統一施加，
      **不依賴 tool 內的 100k**。順序：raw-byte 預過濾 → 抽取 → token cap → append 或 marker。

### 🟡 E. 迴圈控制流陷阱（對照真實程式碼）
- [ ] **Usage**：guard usage 加**一次**（迴圈外），tutor usage **每圈**累加。現況
      [execute-tutor-use-case.ts:178](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L178)
      只加一次，改迴圈時別漏掉逐圈 `addUsage`。
- [ ] **`history` 迴圈內不可變動**：重發沿用同一份 `history` 與同一個 `instruction`／`guardLogId`
      → 既保後端 `derive_verdict` 的 prompt match（guard 不重跑），也讓模型每圈在一致脈絡下重決。
      **別把中間圈的 assistant 回覆 append 進 history。**
- [ ] **終端 dispatch 用「最後一圈」的 actions**，且過濾掉 `load_file`
      （`result.actions.filter(a => a.type !== 'load_file')`）。同回的 `edit_file` 在「決定續傳」
      時**丟棄**（§4.5：載入後重決），不可累積。
- [ ] **MAX 邊界**：`i === MAX_CONTINUATIONS` 時即使還有 actionable load 也要 fall through 到
      終端，並 emit「已達載入上限」marker（§9）。
- [ ] **中間圈 prose（`result.content`）顯示與否是 UX 決策**：至少 emit `continuation` 事件
      （§7 item #6）讓 demo／論文敘事看得到「自動載入 X 後續傳」。

---

## 3. nits（F — 實作 follow-up）

- [ ] **測試簽章已漂移**：
      [execute-tutor-use-case.test.ts:77](../tyla/tests/unit/application/execute-tutor-use-case.test.ts#L77)
      等處呼叫 `new ExecuteTutorUseCase(deps, 'tutor-guide')`，但實際 constructor
      [只收一個參數](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L90)。第二個 arg
      是 dead（vitest/esbuild 不型別檢查才沒爆）。新增 §9 迴圈測試時順手對齊。
- [ ] **迴圈測試用 `mockResolvedValueOnce` 串接**：現有 `makeTutor` 用單值 `mockResolvedValue`
      （[test:21-23](../tyla/tests/unit/application/execute-tutor-use-case.test.ts#L21-L23)）。
      模擬 `load A → edit A` 要讓 `send` 第 1 次回 load_file、第 2 次回 edit_file。
      現有 `makeOptionB` harness 可重用。
- [ ] **`/4` token 估算對程式碼會低估**（code 多短 token）。當 placeholder 可以，但 §8 Phase 0
      校準 per-turn cap 時要往保守抓，否則仍可能越過 8K 觸發 whole-or-drop。

---

## 4. 建議落地順序

**前置 scope（本期 — A/B/C）：**
1. **B**（`IFileSystem.realpath`）→ 解鎖 `PathConfinement` 可測。
2. **A-1**（`PathConfinement` primitive + §9 path 單元測試：相對 OK／絕對拒／`..` 跳脫拒／
   symlink 跳脫拒／Win32 drive+UNC 拒／realpath 收斂）。安全防線，先測先安心。
3. **A-2**（`FileReadService` 採用 primitive、constructor 綁 root；跑 ask / ReAct 既有測試確認不退）。
4. **C**（base 讀檔改套新 token cap）。

**B3 實作階段（follow-up — D/E/F，按需拉入）：**
5. **D**（buffer 嗅探、PDF 先收斂）；B3 driver 呼叫同一 primitive。
6. **E**（包迴圈），用 `mockResolvedValueOnce` 寫 load→edit／去重／unavailable／MAX 終止四組測試。

---

## 5. 與原計畫的對應

| 本文代號 | 原計畫對應 | 關係 |
|---|---|---|
| A | §3.1 規則 1-4、§3.2、§7 item #2/#3 | 補：錨定 `directory`；**決策**＝共用 `PathConfinement` primitive（confinement 統一、cap 各自） |
| B | §3.2 規則 4 | 補：IFileSystem 缺 `realpath`，列入改動清單；隨 A 拍板用注入式而非繞過 |
| C | §4.7、§6.1 | 補：base 讀檔同樣未上 cap，毒源在迴圈之前 |
| D | §4.1、§4.2 | 補：嗅探順序在 buffer、PDF 先收斂再抽取 |
| E | §2 偽碼、§5 不變式 | 補：usage／history／終端 dispatch／MAX 邊界落地提醒 |
| F | §9 | 補：測試簽章漂移、mock 串接、token 估算保守 |
