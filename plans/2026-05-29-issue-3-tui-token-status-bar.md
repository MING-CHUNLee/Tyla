# Plan — Issue 3 (TUI slice): Token Usage in StatusBar

> **Date:** 2026-05-29
> **Status:** READY TO EXECUTE
> **Parent decision:** `Tyla-api/plans/2026-05-27-meeting-decisions.md` §Issue 3
> **Depends on:** Backend PR "Guard-Token Aggregation" (already merged to `Tyla-api` main as of 2026-05-29)
> **Scope:** `MindyCLI_demo/tyla` only — 7 files across infrastructure → application → presentation layers.

---

## 0. Goal

After this PR the StatusBar shows the **real guard + tutor token cost** for every
turn — including `forbidden` replies (which now carry guard-only tokens from the
backend).

```
── claude-sonnet-4-5 · ████████████████████ 42% · turn 7 · 4 321 in / 512 out ──
```

The `cost` item (`~$0.0023`) is removed from the default items per Q5 (unreliable
in backend-gateway mode — the per-token rate for the student's key is unknown).

---

## 1. Verified state today

### 1.1 What the backend now sends (after the merged PR)

| `status` | `usage` field |
|---|---|
| `done` | `{ input_tokens: G_in + T_in, output_tokens: G_out + T_out }` (guard + tutor sum) |
| `forbidden` | `{ input_tokens: G_in, output_tokens: G_out }` (guard only — **no longer null**) |
| `unavailable` | `{ input_tokens: T_in, output_tokens: T_out }` (tutor only; guard failed before responding) |

### 1.2 Current TUI gaps

| # | Location | Current state | Gap |
|---|---|---|---|
| G1  | `tutor-chat-gateway.ts:13` | Wire type declares `usage: ... \| null` | Safe to keep for belt-and-braces; but `forbidden` branch (L75-81) **omits** `usage` entirely from the returned domain object |
| G2  | `tutor-chat-gateway.ts:93-96` | `data.usage?.input_tokens ?? 0` — no range/type validation | A buggy backend could surface `NaN`, negative, or absurdly large numbers in the UI |
| G3  | `execute-tutor-use-case.ts:92-95` | `forbidden` branch hard-codes `usage: { inputTokens: 0, outputTokens: 0 }` | Discards the guard tokens the gateway now receives |
| G4  | `agent-service.ts:50` | `turn_saved` event carries `usage: unknown` | Type-unsafe; `lastInputTokens`/`lastOutputTokens` never reach the StatusBar |
| G5  | `event-mapper.ts:132-148` | `turn_saved` case builds `StatusBarVM` without any token fields | Tokens are silently dropped |
| G6  | `shared/view-models/index.ts:85-111` | `StatusBarVM` has no token fields; `StatusBarItemKey` has no `'tokens'` | StatusBar cannot render token count |
| G7  | `StatusBar.tsx:36-55` | No `tokens` renderer in `renderers` map | |
| G8  | `App.tsx:30` | `DEFAULT_STATUS_CONFIG.items = ['model','context','turn','cost']` | `cost` should be replaced by `tokens` (Q5) |
| G9  | `execute-tutor-use-case.ts:89` | `guard_blocked` emitted without `reason` field | Violates the `AgentEvent` contract (`reason: string` required); any consumer reading `event.data.reason` gets `undefined` |
| G10 | `agent-service.ts:50` + `event-mapper.ts:132-148` | `turn_saved` event and mapper never carry `responseTimeMs` | `lastResponseTimeMs` / `lastTokensPerSecond` in `StatusBarVM` are always `undefined` — `latency` and `tps` renderers always blank |

---

## 2. Design — minimal change set

### 2.1 `tutor-chat-gateway.ts` — add `usage` to the `forbidden` branch + runtime validation

**Current** ([tutor-chat-gateway.ts:13-20](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts#L13-L20)):
```ts
interface TutorChatResponse {
    ...
    usage: { input_tokens: number; output_tokens: number } | null;
}

export type TutorChatResult =
    | { status: 'done' | 'unavailable'; logId: number; content: string; usage: { inputTokens: number; outputTokens: number }; guardSkipped: boolean }
    | { status: 'forbidden'; logId: number; content: string };   // ← no usage
```

**After:**
```ts
interface TutorChatResponse {
    ...
    usage: { input_tokens: number; output_tokens: number } | null;  // keep | null for safety
}

export type TutorChatResult =
    | { status: 'done' | 'unavailable'; logId: number; content: string; usage: { inputTokens: number; outputTokens: number }; guardSkipped: boolean }
    | { status: 'forbidden';            logId: number; content: string; usage: { inputTokens: number; outputTokens: number } };  // ← add usage
```

Add a **module-level** validation helper (replaces the inline `?? 0`). Stateless — no `this` reference, so it lives outside the class and can be unit-tested directly:
```ts
// Returns validated non-negative integers; falls back to 0 on invalid.
function parseUsage(raw: { input_tokens: number; output_tokens: number } | null | undefined)
    : { inputTokens: number; outputTokens: number } {
    const MAX = 1_000_000;
    const safe = (n: unknown): number =>
        typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX ? n : 0;
    return { inputTokens: safe(raw?.input_tokens), outputTokens: safe(raw?.output_tokens) };
}
```

Update the `forbidden` branch ([L75-81](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts#L75-L81)):
```ts
// Before
if (data.status === 'forbidden') {
    return { status: 'forbidden', logId: data.log_id, content: data.content };
}

// After
if (data.status === 'forbidden') {
    return {
        status:  'forbidden',
        logId:   data.log_id,
        content: data.content,
        usage:   this.parseUsage(data.usage),
    };
}
```

Update the `done`/`unavailable` return ([L93-96](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts#L93-L96)):
```ts
// Before
usage: {
    inputTokens:  data.usage?.input_tokens  ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
},

// After
usage: this.parseUsage(data.usage),
```

### 2.2 `execute-tutor-use-case.ts` — use real guard tokens on `forbidden`

**Current** ([L88-95](../tyla/src/application/use-cases/execute-tutor-use-case.ts#L88-L95)):
```ts
if (result.status === 'forbidden') {
    ...
    return {
        content: result.content,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    };
}
```

**After:**
```ts
if (result.status === 'forbidden') {
    this.deps.emit('guard_blocked', { reason: 'content_policy', phase: 'guard' });  // ← add reason (G9)
    this.deps.emit('text_output', { content: result.content });
    this.deps.emit('phase_end', { phase: 'tutor', success: true });
    return {
        content: result.content,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 },
    };
}
```

> **Note:** The `reason` value `'content_policy'` is the only signal available from the gateway-mode response. The local-guard path already provides a richer `guardResult.reason` string — gateway mode collapses this to a fixed label.

### 2.3 `agent-service.ts` — type `turn_saved` with token fields

**Current** ([L50](../tyla/src/application/services/agent-service.ts#L50)):
```ts
| { type: 'turn_saved'; data: { turnCount: number; usage: unknown; sessionId: string; model: string; usagePercent: number; health: string; totalCostUSD: number } }
```

**After** — replace `usage: unknown` with named token fields the mapper can read. The `last` prefix on all three fields means "from the most recent turn", distinguishing them from cumulative session totals (`totalCostUSD`, `usagePercent`). Also adds `lastResponseTimeMs` to fix the orphaned `latency`/`tps` renderers (G10):
```ts
| { type: 'turn_saved'; data: {
    turnCount:            number;
    sessionId:            string;
    model:                string;
    usagePercent:         number;
    health:               string;
    totalCostUSD:         number;
    lastInputTokens:      number;
    lastOutputTokens:     number;
    lastResponseTimeMs?:  number;   // ← new (G10); undefined when gateway path has no timing
  } }
```

Update `emitTurnSaved` ([L365-376](../tyla/src/application/services/agent-service.ts#L365-L376)) to populate those fields from `TurnUsage`:
```ts
private emitTurnSaved(usage: TurnUsage): void {
    const budget = this.session.tokenBudget;
    this.emit({ type: 'turn_saved', data: {
        turnCount:           this.session.turnCount,
        sessionId:           this.session.id,
        model:               this.session.model,
        usagePercent:        budget.usagePercent,
        health:              budget.health,
        totalCostUSD:        this.session.totalCostUSD,
        lastInputTokens:     usage.inputTokens,
        lastOutputTokens:    usage.outputTokens,
        lastResponseTimeMs:  usage.responseTimeMs,
    } });
}
```

### 2.4 `shared/view-models/index.ts` — add token fields + `'tokens'` key

**Current** ([L85-111](../tyla/src/shared/view-models/index.ts#L85-L111)):
```ts
export interface StatusBarVM {
    model: string; usagePercent: number; health: ContextHealthVM;
    totalCostUSD: number; turnCount: number;
    requestsPerMinute?: number; lastTokensPerSecond?: number;
    lastResponseTimeMs?: number; elapsedMs?: number;
}

export type StatusBarItemKey =
    | 'mode' | 'model' | 'context' | 'rpm' | 'cost'
    | 'turn' | 'duration' | 'tps' | 'latency';
```

**After:**
```ts
export interface StatusBarVM {
    model: string; usagePercent: number; health: ContextHealthVM;
    totalCostUSD: number; turnCount: number;
    requestsPerMinute?: number; lastTokensPerSecond?: number;
    lastResponseTimeMs?: number; elapsedMs?: number;
    lastInputTokens?:  number;   // ← new
    lastOutputTokens?: number;   // ← new
}

export type StatusBarItemKey =
    | 'mode' | 'model' | 'context' | 'rpm' | 'cost'
    | 'turn' | 'duration' | 'tps' | 'latency'
    | 'tokens';                  // ← new
```

### 2.5 `event-mapper.ts` — forward token counts in `turn_saved`

**Current** ([L132-148](../tyla/src/tui/presentation/event-mapper.ts#L132-L148)):
```ts
case 'turn_saved': {
    const d = event.data as { turnCount: number; model: string; usagePercent: number; health: string; totalCostUSD: number };
    return {
        sideEffect: {
            statusData: {
                turnCount: d.turnCount, model: d.model,
                usagePercent: d.usagePercent, health: d.health as ContextHealthVM,
                totalCostUSD: d.totalCostUSD,
            } satisfies StatusBarVM,
        },
    };
}
```

**After** — remove the `as {...}` cast (now that the event type is properly typed, TypeScript narrows automatically in the `case` branch) and forward all three new fields:
```ts
case 'turn_saved': {
    const d = event.data;
    return {
        sideEffect: {
            statusData: {
                turnCount:           d.turnCount,
                model:               d.model,
                usagePercent:        d.usagePercent,
                health:              d.health as ContextHealthVM,
                totalCostUSD:        d.totalCostUSD,
                lastInputTokens:     d.lastInputTokens,
                lastOutputTokens:    d.lastOutputTokens,
                lastResponseTimeMs:  d.lastResponseTimeMs,  // ← fixes latency/tps renderers (G10)
            } satisfies StatusBarVM,
        },
    };
}
```

### 2.6 `StatusBar.tsx` — add `tokens` renderer

In the `renderers` map ([L36-55](../tyla/src/tui/presentation/components/StatusBar.tsx#L36-L55)), add after `latency`:
```tsx
tokens: () => (vm.lastInputTokens !== undefined && vm.lastInputTokens > 0)
    ? <Text dimColor>{vm.lastInputTokens.toLocaleString()} in / {(vm.lastOutputTokens ?? 0).toLocaleString()} out</Text>
    : null,
```

The renderer returns `null` when `lastInputTokens` is `undefined` (before the first `turn_saved`) or `0` (e.g., `parseUsage` fell back to zero on a null backend response) — the item is simply omitted rather than showing a misleading `0 in / 0 out`.

### 2.7 `App.tsx` — replace `'cost'` with `'tokens'` in default items

**Current** ([L29-31](../tyla/src/tui/presentation/App.tsx#L29-L31)):
```ts
const DEFAULT_STATUS_CONFIG: StatusBarDisplayConfig = {
    items: ['model', 'context', 'turn', 'cost'],
};
```

**After:**
```ts
const DEFAULT_STATUS_CONFIG: StatusBarDisplayConfig = {
    items: ['model', 'context', 'turn', 'tokens'],
};
```

`cost` renderer remains in `StatusBar.tsx` (it is still a valid `StatusBarItemKey`) so
power users can add it back via config — we just don't display it by default.

---

## 3. File-level change summary

| # | File | Change | Lines (current) |
|---|---|---|---|
| 1 | [`src/infrastructure/api/tutor/tutor-chat-gateway.ts`](../tyla/src/infrastructure/api/tutor/tutor-chat-gateway.ts) | Add `usage` to `TutorChatResult` forbidden variant; add module-level `parseUsage()` helper; update forbidden branch + done/unavailable branch to use it | 13-20, 75-96 |
| 2 | [`src/application/use-cases/execute-tutor-use-case.ts`](../tyla/src/application/use-cases/execute-tutor-use-case.ts) | Use `result.usage` on forbidden branch instead of hard-coded zeros; add `reason: 'content_policy'` to `guard_blocked` emit (G9) | 89, 92-95 |
| 3 | [`src/application/services/agent-service.ts`](../tyla/src/application/services/agent-service.ts) | Replace `usage: unknown` with `lastInputTokens`/`lastOutputTokens`/`lastResponseTimeMs?` in `turn_saved` event; update `emitTurnSaved` (G4, G10) | 50, 365-376 |
| 4 | [`src/shared/view-models/index.ts`](../tyla/src/shared/view-models/index.ts) | Add `lastInputTokens?`/`lastOutputTokens?` to `StatusBarVM`; add `'tokens'` to `StatusBarItemKey` | 85-111 |
| 5 | [`src/tui/presentation/event-mapper.ts`](../tyla/src/tui/presentation/event-mapper.ts) | Remove stale type cast; forward `lastInputTokens`/`lastOutputTokens`/`lastResponseTimeMs` in `turn_saved` case (G5, G10) | 132-148 |
| 6 | [`src/tui/presentation/components/StatusBar.tsx`](../tyla/src/tui/presentation/components/StatusBar.tsx) | Add `tokens` renderer with `> 0` guard | 36-55 |
| 7 | [`src/tui/presentation/App.tsx`](../tyla/src/tui/presentation/App.tsx) | Replace `'cost'` → `'tokens'` in `DEFAULT_STATUS_CONFIG` | 30 |

**No change to:**
- `GuardCheckGateway` / `/api/v1/guard_checks` — different endpoint, out of scope.
- `ExecuteAskUseCase`, `ExecuteInstructionUseCase` — not gateway-mode calls.
- Any other `StatusBarItemKey` renderer — `cost` stays available (just not default).
- History trimming / `compactHistory` — unchanged.

---

## 4. Test plan

### 4.1 Unit tests (Vitest / Jest — wherever existing specs live)

**`tutor-chat-gateway.test.ts` — new cases:**

Use discriminated union narrowing instead of `as any` for type-safe assertions:
```ts
it('maps forbidden usage to the domain result', async () => {
    mockAxios({ status: 200, data: { log_id: 1, status: 'forbidden', content: 'redirect',
                                     usage: { input_tokens: 80, output_tokens: 12 } } });
    const result = await gateway.send('prompt', []);
    expect(result.status).toBe('forbidden');
    if (result.status === 'forbidden') {
        expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 12 });
    }
});

it('parseUsage clamps negative values to 0', async () => {
    mockAxios({ status: 200, data: { log_id: 1, status: 'done', content: 'ok',
                                     usage: { input_tokens: -5, output_tokens: 8 } } });
    const result = await gateway.send('prompt', []);
    if (result.status === 'done') {
        expect(result.usage.inputTokens).toBe(0);
        expect(result.usage.outputTokens).toBe(8);
    }
});

it('parseUsage clamps non-integer to 0', async () => {
    mockAxios({ status: 200, data: { log_id: 1, status: 'done', content: 'ok',
                                     usage: { input_tokens: 1.5, output_tokens: NaN } } });
    const result = await gateway.send('prompt', []);
    if (result.status === 'done') {
        expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    }
});

it('parseUsage handles null usage gracefully', async () => {
    mockAxios({ status: 200, data: { log_id: 1, status: 'done', content: 'ok', usage: null } });
    const result = await gateway.send('prompt', []);
    if (result.status === 'done') {
        expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    }
});
```

**`execute-tutor-use-case.test.ts` — add `guard_blocked` reason check:**
```ts
it('emits guard_blocked with reason on forbidden gateway response', async () => {
    mockGateway({ status: 'forbidden', content: 'not allowed',
                  usage: { inputTokens: 80, outputTokens: 12 } });
    await useCase.execute('attack prompt', []);
    expect(emittedEvents).toContainEqual(
        expect.objectContaining({ type: 'guard_blocked', data: expect.objectContaining({ reason: 'content_policy' }) })
    );
});
```

**`event-mapper.test.ts` — adjust `turn_saved` case:**
```ts
it('surfaces token counts and response time in statusData', () => {
    const event: AgentEvent = { type: 'turn_saved', data: {
        turnCount: 3, sessionId: 'x', model: 'm',
        usagePercent: 10, health: 'healthy', totalCostUSD: 0,
        lastInputTokens: 4321, lastOutputTokens: 512,
        lastResponseTimeMs: 1234,
    } };
    const { sideEffect } = mapAgentEventToMessage(event);
    expect(sideEffect?.statusData?.lastInputTokens).toBe(4321);
    expect(sideEffect?.statusData?.lastOutputTokens).toBe(512);
    expect(sideEffect?.statusData?.lastResponseTimeMs).toBe(1234);
});
```

### 4.2 Manual smoke test

```
# Start backend
bundle exec rackup

# In a second terminal, run the TUI with gateway mode active
TYLA_API_HOST=localhost bun run tyla -- agent "Why is FD least sensitive to outliers?"
```

Observe:
1. `done` turn → StatusBar shows e.g. `4 321 in / 512 out`.
2. Submit an attack-like prompt → `forbidden` turn → StatusBar shows guard-only token count (small, < 200 tokens typically).
3. Stop backend, submit a prompt → `unavailable` turn → StatusBar shows tutor-only token count.

---

## 5. Execution checklist

- [ ] Edit `tutor-chat-gateway.ts` — add module-level `parseUsage`; update `TutorChatResult` forbidden variant; update forbidden + done/unavailable branches to use it.
- [ ] Edit `execute-tutor-use-case.ts` — use `result.usage` on forbidden branch; add `reason: 'content_policy'` to `guard_blocked` emit (G9).
- [ ] Edit `agent-service.ts` — replace `usage: unknown` with `lastInputTokens`/`lastOutputTokens`/`lastResponseTimeMs?` in `turn_saved` event type; update `emitTurnSaved` (G4, G10).
- [ ] Edit `shared/view-models/index.ts` — add `lastInputTokens?`, `lastOutputTokens?`, `'tokens'` key.
- [ ] Edit `event-mapper.ts` — remove stale type cast; forward `lastInputTokens`/`lastOutputTokens`/`lastResponseTimeMs` in `turn_saved` case (G5, G10).
- [ ] Edit `StatusBar.tsx` — add `tokens` renderer with `> 0` guard.
- [ ] Edit `App.tsx` — replace `'cost'` → `'tokens'` in `DEFAULT_STATUS_CONFIG`.
- [ ] `bun run test` — green.
- [ ] Manual smoke test: verify all three status branches show correct token numbers; verify `latency` renderer shows ms when a local LLM path is used.

---

## 6. Risks & non-issues

- **Coordination risk:** The backend PR is already merged. The TUI currently receives a non-null
  `usage` on `forbidden` but silently ignores it (no breakage). This PR is safe to land at any
  time after the backend PR ships.

- **`cost` removal:** `cost` stays as a valid `StatusBarItemKey` in both the type and the renderer
  — only the default config changes. No TypeScript error; no test to remove.

- **`turn_saved` type change:** `usage: unknown` is removed. Any code that read `event.data.usage`
  directly will get a TypeScript error pointing to the exact call site. A grep confirms only
  `emitTurnSaved` (the producer) and the mapper's `turn_saved` case (the consumer) touch this
  field — both are updated in this PR.
