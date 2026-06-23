# B3 Follow-up — 實作計畫

**日期：** 2026-06-09  
**依據：** `plans/2026-06-08-b3-design-decisions-report.md` §五  
**範圍：** 4 個未完成項目（D partial、E、F×2）+ remove-phase0 遺留測試任務

---

## 現況摘要（codebase review 結論）

| 代號 | 原始描述 | 現況 |
|------|---------|------|
| D (partial) | base readFiles PDF 仍走 `pdf_read` tool | 實作已正確：`readFiles()` 已用 `loader.resolve()` 統一路徑；**只剩 docstring 過時** |
| E | 中間圈 prose 靜默，未 emit `continuation` 詳細事件 | **未實作** — `madeProgress=true` 時只 emit `{ iteration, loaded }`，`result.content` 被丟棄 |
| F | 測試簽章漂移（constructor arg mismatch） | `new ExecuteTutorUseCase(deps, 'tutor-guide')` 的二參問題已在 remove-phase0 中修正；但 **budget tests 仍壞**（見下） |
| F | Token `/4` 估算對 code 低估 | 未加 calibration 備注，Phase 0 前先標記 TODO |

### Budget tests 為何壞（F 主要殘留）

`makeFs()` 缺 `realpath` mock → `PathConfinement.resolveWithinRoot()` 執行 `this.fileSystem.realpath(root)` 時丟 `TypeError: this.fileSystem.realpath is not a function`。該 error 被 `readFiles()` 的 catch 吞掉，所有檔案被 skip，`file_context` 為空 → budget 斷言全失敗。

同時，`makeReadRegistry` 仍在 registry 掛 `file_read` mock（實作已改用 `fileSystem.readBuffer()`，不再呼叫 registry 的 `file_read`），造成 content mock 完全無效。

### remove-phase0 遺留（未加的測試）

`plans/2026-06-09-remove-phase0-gateway-guard.md` Step 6 要求在 `agent-service.test.ts` 加一個 `tutorUseCase: null` → error 事件的測試，目前尚未加入。

---

## 任務清單（依優先順序）

### 任務 1：修正 budget tests（F — 解除 blocking）

**檔案：** `tyla/tests/unit/application/execute-tutor-use-case.test.ts`

**Step 1a** — 在 `makeFs()` 加入 `realpath` mock（identity：回傳路徑本身，滿足 symlink 測試即可）

```typescript
// 加在 stat: vi.fn() 之後
realpath: vi.fn().mockImplementation((p: string) => p),
```

**Step 1b** — 把 `makeReadRegistry` 從「提供 registry `file_read` mock」改為「提供 `fileSystem.readBuffer` mock」。

舊版：
```typescript
function makeReadRegistry(files, contentFor) {
    const fileScan = { execute: vi.fn()... };
    const fileRead = { execute: vi.fn(async ({ path }) => ({ isError: false, content: contentFor(path) })) };
    return (name) => (name === 'file_scan' ? fileScan : name === 'file_read' ? fileRead : undefined);
}
```

新版（回傳物件，分離 registryGet 與 fileSystem override）：
```typescript
function makeReadRegistry(
    files: Array<{ name: string; path: string }>,
    contentFor: (filePath: string) => string,
): { registryGet: (name: string) => unknown; fileSystem: IFileSystem } {
    const fileScan = {
        execute: vi.fn().mockResolvedValue({
            content: 'scan summary',
            data: { files: { rScripts: files } },
        }),
    };
    const fileSystem = makeFs({
        readBuffer: vi.fn().mockImplementation((p: string) => Buffer.from(contentFor(p))),
    });
    return {
        registryGet: (name: string) => (name === 'file_scan' ? fileScan : undefined),
        fileSystem,
    };
}
```

**Step 1c** — 更新三個 budget tests 的呼叫點，使用新簽章：

```typescript
// 舊
const { deps } = makeOptionB({ registryGet: makeReadRegistry(files, () => bigContent(5_000)) });

// 新
const { registryGet, fileSystem } = makeReadRegistry(files, () => bigContent(5_000));
const { deps } = makeOptionB({ registryGet, fileSystem });
```

---

### 任務 2：emit 中間圈 prose（E）

**Step 2a** — `tyla/src/application/use-cases/execute-tutor-use-case.ts`：在 `madeProgress` 分支加入 `intermediateContent`

```typescript
// 舊（L202-204）
if (madeProgress) {
    this.deps.emit('continuation', { iteration: i + 1, loaded: [...resolved.keys()] });
    continue;
}

// 新
if (madeProgress) {
    this.deps.emit('continuation', {
        iteration: i + 1,
        loaded: [...resolved.keys()],
        intermediateContent: result.content,   // tutor 解釋為何要求更多檔案
    });
    continue;
}
```

**Step 2b** — `tyla/src/application/services/agent-service.ts`：把 `continuation` 加入 `AgentEvent` 聯合型別

```typescript
| { type: 'continuation'; data: {
    iteration: number;
    loaded: string[];
    intermediateContent: string;   // tutor 的中間圈 prose（可能為空字串）
} }
```

---

### 任務 3：更新 `readFiles()` docstring（D partial）

**檔案：** `tyla/src/application/use-cases/execute-tutor-use-case.ts`，L381-385

舊 docstring（提到 `file_read / pdf_read`，已過時）：
```
/**
 * Read a fixed set of files through file_read / pdf_read, concatenating their
 * contents under the shared per-turn token budget (gap-list §C): each file is
 * capped per-file, and once the per-turn pool is spent the remaining files are
 * refused with a visible marker rather than silently dropped.
 */
```

新 docstring：
```
/**
 * Read a fixed set of files through ContinuationFileLoader.resolve(), concatenating
 * their contents under the shared per-turn token budget (gap-list §C). Each file is
 * capped per-file; once the per-turn pool is spent the remaining files are refused
 * with a visible marker rather than silently dropped. PDF, binary, and symlink-escape
 * checks are all handled inside the loader.
 */
```

---

### 任務 4：加 `tutorUseCase: null` 測試（remove-phase0 遺留）

**檔案：** `tyla/tests/unit/application/agent-service.test.ts`

在現有 `describe('AgentService', ...)` 區塊內新增 describe block：

```typescript
describe('executeInstruction() — tutor mode, no gateway', () => {
    it('emits error when tutorUseCase is null and mode is non-default', async () => {
        const { service, events } = makeService();
        // Override tutorUseCase to null after construction (DI workaround)
        // Simpler: build deps directly with tutorUseCase: null
        const events2: AgentEvent[] = [];
        const eventBus2 = new EventBus();
        const repo2 = makeMockRepo();

        const deps2: AgentServiceDeps = {
            .../* same structure as makeService() deps */,
            tutorUseCase: null,
            modeManager: new ModeManager('tutor-socratic'),
        };

        const svc = new AgentService(
            { directory: '/fake/project' },
            (e) => events2.push(e),
            deps2,
        );
        await svc.initialize();
        await svc.executeInstruction('help me');

        const err = events2.find(e => e.type === 'error');
        expect(err?.data.message).toContain('not configured');
    });
});
```

> 具體 deps 構建方式與 `makeService()` 相同，但將 `tutorUseCase` 設為 `null`，並把 `modeManager` 初始化為 `'tutor-socratic'` 確保路由進入 tutor 分支。

---

### 任務 5：token /4 calibration 備注（F minor）

**檔案：** `tyla/src/application/services/file-context-budget.ts`

在 `take()` 裡 `cap * 4` 的地方加備注：

```typescript
// ~4 chars/token for English/R source; may undercount dense code — recalibrate in Phase 0.
const capChars = cap * 4;
```

---

## 執行順序

```
1. 任務 1（budget tests 修正）→ bun run test 確認 budget describe 通過
2. 任務 2（emit E）→ bun run build 確認型別無誤
3. 任務 3（docstring）
4. 任務 4（null tutorUseCase test）→ bun run test 確認全綠
5. 任務 5（calibration comment）
```

---

## 驗收標準

- `bun run build`：零 TypeScript 錯誤
- `bun run test`：所有測試通過，包含 budget describe block
- `continuation` event 在 B3 中間圈攜帶 `intermediateContent`（TUI 可選擇性顯示）
- `readFiles()` docstring 正確反映 `ContinuationFileLoader.resolve()` 路徑
