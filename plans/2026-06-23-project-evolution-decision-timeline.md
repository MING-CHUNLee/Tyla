# 專案演變與關鍵決策時間軸 / Project Evolution & Key Decision Timeline

> **整理日期 / Compiled:** 2026-06-23
> **視角 / Lens:** Research through Design（透過設計進行研究) + 資深工程師 code review
> **資料來源 / Sources:** `git log`(2026-01 ~ 2026-06)、`plans/archive/` 設計文件、`plans/feature_comparison_and_planning/`
> **產品演進 / Product lineage:** `MindyRtd-CLI` → `Mindy` → **`Tyla`**（R 程式碼助手 → AI 課程助教 / R coding assistant → AI course tutor)

---

## 0. 如何閱讀本文 / How to read this

本文把專案三條敘事線交織呈現 / This document interleaves three narrative threads:

1. **時間軸 / Timeline** — 以「階段(Phase)」分段，每段標註月份與代表性 commit。
   Segmented by phases, each tagged with months and representative commits.
2. **決策分類 / Decision taxonomy** — 每個關鍵決策標註類型代碼(見 §1)。
   Each key decision is tagged with a type code (see §1).
3. **設計論證 / Design rationale** — 「為什麼這樣選」而非「做了什麼」,這是 RtD 的核心。
   The *why*, not the *what* — the heart of research through design.

---

## 1. 決策類型分類 / Decision Type Taxonomy

| 代碼 Code | 類型 Type (中) | Type (EN) | 說明 Description |
|---|---|---|---|
| **ARCH** | 架構 | Architecture | 分層、模組邊界、依賴方向 / Layering, module boundaries, dependency direction |
| **PIVOT** | 產品定位轉向 | Product Pivot | 目標使用者與核心價值的轉變 / Shift in target users & core value |
| **SEC** | 安全與防禦 | Security & Safety | 防越獄、路徑限制、機密不外洩 / Anti-jailbreak, path confinement, secret containment |
| **CTX** | 上下文工程 | Context Engineering | token 預算、檔案載入、壓縮 / Token budget, file loading, compaction |
| **TECH** | 技術選型 | Technology Choice | 函式庫、執行環境、建置工具 / Libraries, runtime, build tooling |
| **BND** | 前後端責任邊界 | Client/Server Boundary | 邏輯放前端或後端 / What lives on client vs. server |
| **BRAND** | 命名與品牌 | Naming & Branding | 專案/模組命名 / Project & module naming |
| **QA** | 測試與品質 | Testing & Quality | 測試策略、回歸保護 / Test strategy, regression protection |

---

## 2. 高層時間軸概覽 / High-Level Timeline Overview

| 階段 Phase | 期間 Period | 主題 Theme (中) | Theme (EN) | 主要決策類型 Dominant types |
|---|---|---|---|---|
| **P0** | 2026-01 | R 助手地基 | R-assistant foundation | TECH, ARCH |
| **P1** | 2026-01 ~ 03 | Clean Architecture + Agentic 化 | Clean Architecture + going agentic | ARCH, TECH |
| **P2** | 2026-03 ~ 04 | DDD 硬化與管線成形 | DDD hardening & pipeline shaping | ARCH, QA |
| **P3** | 2026-03 ~ 05 | 轉向教育:作業工作流模式 | Pivot to education: homework modes | **PIVOT**, ARCH, BRAND |
| **P4** | 2026-05 | 防護代理人(Guard) | Guard agent & safety | **SEC** |
| **P5** | 2026-05 ~ 06 | 瘦客戶端 + 後端遷移 | Thin client + backend migration | **BND**, SEC |
| **P6** | 2026-06 | Agentic 助教 + 上下文工程 | Agentic tutor + context engineering | **CTX**, SEC, ARCH |

---

## 3. 各階段關鍵決策點 / Key Decisions by Phase

### P0 — R 助手地基 / R-Assistant Foundation（2026-01)

> 起點是一個 **RStudio 工作流的 R 程式碼助手**,不是 AI 助教。
> The project began as an **R coding assistant for the RStudio workflow**, not an AI tutor.

| # | 決策 Decision (中) | Decision (EN) | 類型 | Commit / 依據 |
|---|---|---|---|---|
| D01 | 掃描 RStudio 相關檔案作為上下文來源 | Scan RStudio-related files as context source | ARCH | `feat:scan all related files in RStudio` (01-12) |
| D02 | 偵測並列出已安裝 R 套件、做 OS 專屬目錄對映 | Detect installed R packages; OS-specific lib dir mapping | TECH | (01-15, 01-20) |
| D03 | 抽出 Context Builder + LLM Controller 兩個核心抽象 | Extract Context Builder + LLM Controller abstractions | ARCH | `feat: implement context builder architecture and LLM controller` (01-21) |
| D04 | 提供 `run` 指令直接執行 R 程式碼 | `run` command to execute R code directly | TECH | (01-26) |

**設計論證 / Rationale:** 先把「讀懂專案 + 跑得動 R」做穩,確立工具是貼著 **R 資料科學的真實工作流**而非通用 chatbot。這個「貼近真實工作流」的取向貫穿全程,是後續轉向課程助教的伏筆。
Establishing "understand the project + actually run R" first anchored the tool to a **real R data-science workflow** rather than a generic chatbot — a stance that persists and foreshadows the later tutor pivot.

---

### P1 — Clean Architecture + Agentic 化 / Clean Architecture + Going Agentic（2026-01 ~ 03）

| # | 決策 Decision (中) | Decision (EN) | 類型 | Commit / 依據 |
|---|---|---|---|---|
| D05 | 採用 Clean Architecture 四層分層 | Adopt 4-layer Clean Architecture | ARCH | `refactor: adopt Clean Architecture layered structure` (01-27) |
| D06 | 評估並導入 Ink TUI(終端介面) | Evaluate & adopt Ink-based TUI | TECH | `feat:feasibility of TUI` (01-27) |
| D07 | 導入自主 agent 工作流(初期接 Gemini)+ 非同步日誌 | Introduce autonomous agent workflow (Gemini) + async logging | PIVOT | `feat(agent): introduce autonomous agent workflow` (02-28) |
| D08 | 短暫引入 Ruby 後端(`POST /resolve`、`/edit`) | Briefly introduce a Ruby backend | BND | (03-01) → **後於 03-31 移除 / later removed** |
| D09 | 加入對話記憶與上下文管理 | Conversational memory + context management | CTX | (03-05) |
| D10 | 以意圖分類自動切換 ask / edit 模式 | Auto-switch ask/edit via intent classification | ARCH | `feat: auto-switch between ask and edit modes` (03-10) |
| D11 | Session 持久化 + token 追蹤 | Session persistence + token tracking | CTX | (03-10) |

**設計論證 / Rationale:**
- **Clean Architecture(D05)** 是整個專案最早、影響最深遠的架構承諾——依賴只向內(presentation/infra → application → domain)。它讓後續所有大改(換 LLM provider、拔掉 Ruby 後端、瘦客戶端)都能局部進行。
  Clean Architecture is the earliest and most consequential architectural commitment; inward-only dependencies made every later upheaval *local*.
- **Ruby 後端(D08)的引入又移除**是重要的「試錯」決策點:團隊一度想把 resolve/edit 放到伺服器,但很快發現對單機 CLI 而言增加了部署負擔,於 03-31 `refactor(api): remove Ruby API dependency` 收回。這是 RtD 典型的「建造以學習」。
  The Ruby backend's introduce-then-remove is a textbook *build-to-learn* moment: server-side resolve/edit added deployment burden for a single-machine CLI and was reverted within a month.

---

### P2 — DDD 硬化與管線成形 / DDD Hardening & Pipeline Shaping（2026-03 ~ 04）

| # | 決策 Decision (中) | Decision (EN) | 類型 | Commit / 依據 |
|---|---|---|---|---|
| D12 | 拆解 `AgentService` 上帝物件 | Decompose the `AgentService` god object | ARCH | `refator:decompose AgentService god object` (03-17) |
| D13 | 區分 artifact:`fileChange` vs `LLMOutput` | Split artifact into `fileChange` / `LLMOutput` | ARCH | (03-17) |
| D14 | 階段式核准流(Staged approval / Phase 3 安全閘) | Staged-approval edit flow (Phase 3 safety gate) | SEC | `extract FileEditTool and split ApplyEdits into staged approval flow` (03-21) |
| D15 | PDF 讀取工具 | PDF reading tool | TECH | (03-20) |
| D16 | 事件驅動設計:Service 發事件,Controller 渲染 | Event-driven design (Service emits, Controller renders) | ARCH | (貫穿 / throughout) |
| D17 | BDD 驗收測試 + cassette fixtures | BDD acceptance tests + cassette fixtures | QA | `feat:BDD acceptance tests` (03-27) |
| D18 | DDD 型別遷移、domain 提升為頂層 | DDD type migration; promote domain to top level | ARCH | (03-12, 04-10) |
| D19 | Presentation 層 ViewModel + 純 formatter | ViewModels + pure formatters in presentation | ARCH | (04-09) |
| D20 | 切換套件管理器至 **Bun** | Switch package manager to **Bun** | TECH | (03-25) |
| D21 | 遷移至 ESM + bundler 模組解析 | Migrate to ESM with bundler resolution | TECH | (04-24) |

**設計論證 / Rationale:**
- **階段式核准(D14)** 是貫穿至今的安全核心:LLM 產生的編輯產物(JSON 陣列)被攔截、diff、經使用者核准才寫入磁碟。教育情境下「AI 不能擅自改學生作業」使這個閘門從工程慣例升格為產品價值。
  Staged approval is a safety cornerstone: LLM edit artifacts are intercepted, diffed, and require user approval. In an education context, "AI must not silently edit a student's work" elevates it from engineering hygiene to product value.
- **事件驅動(D16)** 讓業務邏輯與 Ink TUI 解耦,使單元測試不需網路即可驗證,直接支撐 D17 的 BDD 測試策略。
  Event-driven design decoupled logic from the Ink TUI, enabling network-free unit tests and the BDD strategy.

---

### P3 — 轉向教育:作業工作流模式 / Pivot to Education（2026-03 ~ 05）

> **整個專案的重心轉折點。** 從「R 程式碼助手」轉為「AI 課程助教」。
> **The project's center of gravity shifts** — from R coding assistant to AI course tutor.

| # | 決策 Decision (中) | Decision (EN) | 類型 | Commit / 依據 |
|---|---|---|---|---|
| D22 | 引入多模式:`solver` / `tutor-socratic` / `tutor-guide` | Multi-mode: solver / tutor-socratic / tutor-guide | **PIVOT** | `feat(workflow): add multi-mode support` (03-29) |
| D23 | 抽出 `ModeManager` + `SlashCommandRouter` | Extract `ModeManager` + `SlashCommandRouter` | ARCH | (03-29) |
| D24 | 雙進入點重構(Option B):`index.ts` 純 dispatcher,CLI/TUI 互斥 | Dual-entrypoint restructure (Option B) | ARCH | `2026-04-19-option-b-dual-entrypoints-restructure.md` |
| D25 | 將模式政策外部化為 `agent/*.md`(後改 `tutors/`) | Externalize mode policies to markdown | ARCH | (04-30) |
| D26 | AI 助教 login / init 流程 + 政策架構 | AI tutor login-init flow + policy architecture | PIVOT | `2026-04-30-ai-tutor-login-init-design.md` |
| D27 | `--assignment` flag:每份作業獨立政策 | `--assignment` flag for per-assignment policy | PIVOT | `2026-05-04-assignment-flag-implementation.md` |
| D28 | 移除 `solver` 模式,統一為 tutor 工作流 | Remove `solver` mode; unify on tutor workflow | **PIVOT** | `refactor: remove solver mode and unify tutor workflow` (05-15) |
| D29 | 重新命名 `cli/` → `mindy-cli/` → 專案改名 **Tyla** | Rename to `mindy-cli` → project renamed **Tyla** | BRAND | (04-21, 05-10) |

**設計論證 / Rationale:**
- **多模式(D22)→ 移除 solver(D28)** 是一條完整的 RtD 學習弧線:先用三種模式探索(直接解題 vs. 蘇格拉底式 vs. 引導式),透過實作與比較(見 `feature_comparison_and_planning/` 對 Khanmigo / MathGPT / Squirrel AI 的比較),最終認定「直接給答案的 solver」與教學目標衝突,**主動刪除自己做出來的功能**。這是「透過設計來研究」最有報告價值的一步。
  Multi-mode → removing solver is a complete RtD learning arc: three modes were built to *explore* (direct-solve vs. Socratic vs. guided), compared against prior products (Khanmigo, MathGPT, Squirrel AI), and the direct-answer solver was then *deliberately deleted* as conflicting with pedagogy. Deleting your own working feature is the most report-worthy RtD move.
- **政策外部化(D25)** 把「助教人格 / 作業規則」從程式碼抽到 markdown,讓非工程的課程設計者也能調整教學策略——體現「設計物件作為研究探針」。
  Externalizing policy to markdown lets non-engineer course designers tune pedagogy — the design artifact as a research probe.
- **Option B 雙進入點(D24):** 教授確認 CLI 與 TUI 視為完全互斥的獨立路徑,`index.ts` 降格為純 dispatcher,解決原本 TUI out-of-process 與 CLI in-process 的不對稱。
  Per faculty decision, CLI and TUI are fully exclusive paths; `index.ts` became a pure dispatcher, fixing the out-of-process/in-process asymmetry.

---

### P4 — 防護代理人 / Guard Agent & Safety（2026-05）

> 教育情境特有的威脅:**學生會試圖越獄,逼 AI 直接吐答案或洩漏解答。**
> An education-specific threat: **students will jailbreak the AI to extract answers or solutions.**

| # | 決策 Decision (中) | Decision (EN) | 類型 | Commit / 依據 |
|---|---|---|---|---|
| D30 | 引入 Guard Agent:每個 prompt 先過防護再進 tutor | Guard agent intercepts every prompt pre-tutor | **SEC** | `2026-05-08-guard-agent-design.md` |
| D31 | 混合式防護:規則快篩 + LLM judge 處理模糊案例 | Hybrid guard: rule fast-filter + LLM judge | SEC | 同上 / ibid |
| D32 | 被擋時以**助教人格內**婉拒,而非系統錯誤 | In-persona refusal on block, not a system error | SEC | 同上 / ibid |
| D33 | 英文限定:非英文於 Phase 0 硬擋(零成本) | English-only; non-English hard-blocked at Phase 0 | SEC | 同上 / ibid |
| D34 | 身分探測偵測(identity-probe) | Identity-probe detection | SEC | (05-09) |
| D35 | 機率式 LLM judge(取代二元判斷)+ 可調閾值 | Probability-based LLM judge with tunable threshold | SEC | `feat: guard-agent — probability-based LLM judge` (05-13) |
| D36 | 解答以 **in-memory 檔案系統(`memfs`)** 解密,絕不落地真實磁碟 | Decrypt solutions into an in-memory FS (`memfs`) | **TECH/SEC** | `2026-05-13-in-memory-filesystem-slides-draft.md` |

**設計論證 / Rationale:**
- **混合防護(D31)** 反映成本/準確權衡:規則 regex 零成本擋掉明顯攻擊("ignore all previous instructions"),只有模糊案例才付 LLM judge 的 token 成本。
  Hybrid guarding reflects a cost/accuracy trade-off: zero-cost regex blocks obvious attacks; only ambiguous cases pay for the LLM judge.
- **In-persona 婉拒(D32)** 是教學體驗決策:系統級錯誤會破壞沉浸感並提示攻擊者「踩到防線」;讓助教用自己的口吻婉拒,既不洩漏防護存在,也維持教學關係。
  In-persona refusal is a UX/pedagogy decision: a system error breaks immersion and signals the attacker they hit a wall; an in-voice refusal hides the guard and preserves the tutoring relationship.
- **`memfs` 選型(D36):** 評估 `memfs`(✅ 與 Node `fs` API 相容、可一鍵 `vol.reset()` 清空)vs. `mock-fs`(❌ 僅供測試、全域 patch 有副作用)vs. `@zip.js`(❌ 瀏覽器導向、耦合過深)。解答檔解密後只存在記憶體,session 結束即蒸發,真實磁碟永遠看不到答案。
  `memfs` chosen over `mock-fs` (test-only, global patch) and `@zip.js` (browser-oriented, over-coupled): decrypted solutions live only in memory and evaporate at session end — answers never touch the real disk.

---

### P5 — 瘦客戶端 + 後端遷移 / Thin Client + Backend Migration（2026-05 ~ 06）

> **核心安全洞察:** 把防護邏輯放在學生機器上,等於把「越獄手冊」發給學生。
> **Core security insight:** shipping guard logic to student machines hands them the jailbreak playbook.

| # | 決策 Decision (中) | Decision (EN) | 類型 | Commit / 依據 |
|---|---|---|---|---|
| D37 | 把 guard + policy + jailbreak 目錄整個搬到後端 | Move guard + policy + jailbreak catalog server-side | **BND/SEC** | `2026-05-20-thin-client-frontend.md` |
| D38 | 前端 guard **完全移除**;只保留「被拒」橫幅渲染 | Remove frontend guard entirely; keep only "refused" banner | BND | 同上 / ibid |
| D39 | 僅遷移 tutor 模式;ask/edit/run 仍前端直連 LLM | Migrate only tutor modes; ask/edit/run stay client-direct | BND | 同上 / ibid |
| D40 | LLM 金鑰以 HTTP header(`X-LLM-Provider`/`X-LLM-Key`)轉送,後端不持久化 | LLM key via headers, backend never persists | SEC | 同上 / ibid |
| D41 | Google OAuth / SSO + 學生/課程/專案身分寫入 settings | Google OAuth/SSO + student/course/project identity | PIVOT | (05-10, 05-17) |
| D42 | V1 先非串流("thinking…"),穩定後再開串流 | V1 non-streaming first; re-enable streaming later | CTX | `2026-05-20-thin-client-frontend.md` |
| D43 | `GuardCheckGateway` → 移除,改由 `tutor_chats` API 一次代理 guard+tutor | Collapse guard into the `tutor_chats` API | BND/ARCH | (05-24, 05-27) |

**設計論證 / Rationale:**
- **瘦客戶端(D37/D38)** 是把 D30~D35 的所有防護「位置」推翻重來的決策:**安全邊界必須在學生控制不到的地方。** 任何留在前端的防護都能被改原始碼繞過,因此 guard、政策文字、越獄樣本目錄全數搬到後端。這是 BND × SEC 交叉的代表決策。
  Thin client overturns *where* P4's guards live: the security boundary must be where students can't reach. Anything on the frontend can be patched out, so guard logic, policy text, and the jailbreak catalog all moved server-side.
- **漸進遷移(D39)** 降低風險:只有 tutor 模式依賴後端,ask/edit/run 仍可離線直連,後端掛掉時影響面可控。
  Incremental migration limits blast radius: only tutor depends on the backend; ask/edit/run still run client-direct.
- **API 合併(D43)** 是「少即是多」:`GuardCheckGateway` 才剛建好(05-21)就在 05-27 移除,因為發現 guard 與 tutor 兩次往返會洩漏防護存在且增加延遲,改由後端一個 `tutor_chats` 端點內部完成 guard→tutor。又一個「建造以學習後收回」。
  Collapsing the API is "less is more": `GuardCheckGateway` (built 05-21) was removed 05-27 — two round-trips leaked the guard's existence and added latency, so the backend now does guard→tutor inside one `tutor_chats` endpoint. Another build-to-learn reversal.

---

### P6 — Agentic 助教 + 上下文工程 / Agentic Tutor + Context Engineering（2026-06）

> 助教不只回話,還能**要求載入更多檔案、提出可核准的編輯/執行動作**。
> The tutor not only replies but can **request more files and propose approvable edit/run actions.**

| # | 決策 Decision (中) | Decision (EN) | 類型 | Commit / 依據 |
|---|---|---|---|---|
| D44 | Tutor action 觸發:把 LLM 回覆中的 action 派發為 staged edit/script | Tutor actions dispatched to staged edits/scripts | ARCH | `2026-06-01-tutor-action-triggering.md` |
| D45 | LLM gateway 除役遷移:tutor 不再前端直連 | Decommission frontend LLM gateway for tutor | BND | `2026-06-03-llm-gateway-decommission-migration.md` |
| D46 | 移除離線 guard 路徑(`GuardAgent` 及死碼) | Remove offline guard path entirely | SEC | (06-06) |
| D47 | **B3 續傳迴圈**:LLM 要求 `load_file` 時前端自動讀入並重送 | B3 continuation loop: auto-load files on `load_file` | **CTX** | `2026-06-07/08` B3 plans |
| D48 | 安全邊界與預算政策**解耦**:共用 `PathConfinement`,各自 token cap | Decouple confinement (shared) from budget (per-caller) | **SEC/CTX** | `2026-06-08-b3-design-decisions-report.md` |
| D49 | Workspace 路徑限制:`realpath` + `path.relative` 防 symlink 逃脫 | Workspace path confinement via realpath + relative check | SEC | 同上 / ibid |
| D50 | `FileContextBudget`:per-turn token 池,超量顯式標記不靜默丟 | Per-turn token budget; explicit skip markers, never silent drop | CTX | 同上 / ibid |
| D51 | 前端在源頭裁切 file_context,排在後端 summarizer **之前** | Trim file_context at source, *before* backend summarizer | CTX | `2026-06-06-frontend-context-optimization.md` |
| D52 | 行號標註檔案上下文 + `@`-gated 讀取 + 錨定 patch | Line-numbered context + @-gated reads + anchored patches | CTX | (06-11, 06-13) |
| D53 | `session_turns` 未壓縮轉送後端,前端不再做 summarizer(Option C) | Forward uncompressed session_turns; drop frontend summarizer | CTX/BND | (06-16) |
| D54 | Provider 429 限流透傳 + 退避指引 | Pass through provider 429 rate limits with back-off guidance | TECH | (06-23, HEAD) |

**設計論證 / Rationale:**
- **B3 續傳 + 安全/預算解耦(D47/D48)** 是本階段最值得報告的架構判斷(見 `2026-06-08-b3-design-decisions-report.md` §六):
  > 所有讀取路徑(ask / ReAct / B3)共用同一個 `PathConfinement` primitive,保證邊界行為一致且可集中測試;各自保有不同的 token 上限,使 B3 能用比 ask 更嚴格的預算管控後端成本。「共用安全邊界 + 獨立預算政策」。
  B3's headline decision: all read paths share one `PathConfinement` primitive (uniform, centrally testable boundary) while keeping independent token caps — *shared safety boundary, independent budget policy.*
- **顯式 skip marker 而非靜默丟棄(D50)** 是上下文工程的可解釋性決策:當 context 因預算被截斷,LLM 會看到 `[skipped: file-context token budget exhausted]`,知道資訊不完整,而非誤以為看到了全部。
  Explicit skip markers (vs. silent drop) are an explainability decision: the LLM sees *why* context was cut, rather than assuming it saw everything.
- **「最便宜的 token 是沒送出去的那個」(D51)** 引用 Anthropic *Effective context engineering*:前端在源頭裁切(零 LLM 成本)優於後端事後壓縮(多一次 LLM 呼叫),且前端先讓出 budget,後端 rolling summary 才放得進去。順序本身是設計決策。
  "The cheapest token is the one never sent": trimming at the source (zero LLM cost) beats backend post-hoc compaction (an extra LLM call), and ordering the frontend trim *before* the backend summarizer is itself the design decision.

---

## 4. 決策類型 × 階段交叉矩陣 / Decision-Type × Phase Matrix

> 觀察各階段重心如何從「架構」逐步移往「安全」「上下文工程」。
> Watch the center of gravity migrate from *architecture* toward *security* and *context engineering*.

| 類型 \ 階段 | P0 | P1 | P2 | P3 | P4 | P5 | P6 |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **ARCH** 架構 | ● | ●● | ●●● | ●● | | ○ | ●● |
| **PIVOT** 定位 | | ● | | ●●● | | ● | |
| **SEC** 安全 | | | ● | | ●●● | ●● | ●● |
| **CTX** 上下文 | | ● | | | | ○ | ●●● |
| **TECH** 技術 | ●● | ● | ● | | ● | | ● |
| **BND** 邊界 | | ○ | | | | ●●● | ● |
| **BRAND** 品牌 | | | | ●● | | | |
| **QA** 測試 | | | ●● | | | | |

`●` = 主要決策密集 / dominant ‧ `○` = 次要涉及 / secondary

---

## 5. 跨階段的「建造以學習」反轉 / Build-to-Learn Reversals (RtD 重點)

RtD 最有價值的證據往往是**主動撤回**——做出來、用上、學到、刪掉。本專案有四個清楚案例:
The richest RtD evidence is *deliberate withdrawal* — build, use, learn, delete. Four clear cases:

| 反轉 Reversal | 引入 Built | 撤回 Removed | 學到了什麼 Lesson |
|---|---|---|---|
| Ruby 後端 / Ruby backend (D08) | 03-01 | 03-31 | 單機 CLI 不需伺服器端 resolve/edit 的部署負擔 / A single-machine CLI doesn't need server-side resolve/edit |
| `solver` 模式 / solver mode (D22→D28) | 03-29 | 05-15 | 直接給答案與教學目標衝突 / Direct answers conflict with pedagogy |
| 前端 Guard / frontend guard (D30→D37) | 05-08 | 05-20~06-06 | 防護不能放在學生能改的地方 / Guards can't live where students can patch them |
| `GuardCheckGateway` (D43) | 05-21 | 05-27 | 兩次往返洩漏防護存在、增加延遲 / Two round-trips leak the guard & add latency |

---

## 6. 一句話總結 / One-Line Summary

> **中:** Tyla 從一個「能跑 R 的程式碼助手」,經由 Clean Architecture 的穩固地基、一次教育定位的主動轉向(刪掉 solver)、一條把防護從前端推到後端的安全弧線,最終收斂為一個「安全邊界共用、預算政策獨立、上下文在源頭裁切」的 agentic 課程助教。
>
> **EN:** Tyla evolved from an "R-running code assistant" through a solid Clean-Architecture foundation, a deliberate pedagogical pivot (deleting the solver), and a security arc that pushed guarding from client to server — converging on an agentic course tutor built on *shared safety boundaries, independent budget policies, and source-level context trimming.*

---

## 附錄:資料來源索引 / Appendix: Source Index

- **早期(P0–P2):** `git log`(2026-01 ~ 2026-04),plans 文件尚未開始累積。
- **中後期(P3–P6):** `plans/archive/` 共 60+ 份設計文件,以日期前綴命名。
- **競品分析 / Prior-product comparison:** `plans/feature_comparison_and_planning/`(Khanmigo, MathGPT, Squirrel AI, BOXFiSH 等)。
- **最深決策報告 / Deepest decision report:** `plans/archive/2026-06-08-b3-design-decisions-report.md`。
