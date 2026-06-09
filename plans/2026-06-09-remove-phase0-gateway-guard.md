# Refactor: Move Gateway Guard out of ExecuteTutorUseCase

**Date:** 2026-06-09
**Problem:** `ExecuteTutorUseCase` checks whether its own dependencies are injected at
runtime (`callGateway()` Phase 0, L125–129). A use case should not know whether it was
correctly assembled — that is the composition root's job.

---

## Root Cause

`ExecuteTutorDeps` declares both gateways as optional:

```ts
tutorChatGateway?: TutorChatGateway;
guardCheckGateway?: GuardCheckGateway;
```

So the factory can legally pass `undefined`, and the use case must defend itself at
call-time with a runtime null-check. The responsibility is in the wrong layer.

---

## Target Design

```
Before
  factory  →  new ExecuteTutorUseCase({ ..., tutorChatGateway: undefined })
  use case →  if (!guardCheckGateway || !tutorChatGateway) throw "not configured"

After
  factory  →  if (gateways exist) new ExecuteTutorUseCase({ ..., guardCheckGateway, tutorChatGateway })
              else tutorUseCase = null
  service  →  if (!tutorUseCase) throw "not configured"   ← routing concern, correct layer
  use case →  (no null check — TypeScript guarantees gateways exist if constructed)
```

The use case becomes a pure pipeline; the "is this feature available?" question lives at
the routing layer (`AgentService`), where it belongs.

---

## Files to Change

### 1. `tyla/src/application/use-cases/execute-tutor-use-case.ts`

**a) Make gateways required in `ExecuteTutorDeps`**

```diff
-    tutorChatGateway?: TutorChatGateway;
-    guardCheckGateway?: GuardCheckGateway;
+    tutorChatGateway: TutorChatGateway;
+    guardCheckGateway: GuardCheckGateway;
```

**b) Delete Phase 0 guard check (L121–129)**

```diff
 private async callGateway(instruction: string, history: SessionMessage[]): Promise<TutorResult> {
-    // ── 0. Guard the gateways ──────────────────────────────────────────────
-    // After §5e removes the offline path, execute() calls straight here. Without
-    // these checks, an undefined gateway throws a raw TypeError. Surface a clear
-    // message instead.
-    if (!this.deps.guardCheckGateway || !this.deps.tutorChatGateway) {
-        const msg = 'Tutor backend not configured — set a valid profile.json and restart tyla.';
-        this.deps.emit('error', { message: msg, phase: 'guard' });
-        throw new Error(msg);
-    }
-
     // ── 1. file_context ...
```

**c) Update JSDoc (L1–9)**

```diff
- * Tutor workflow mode pipeline (Option B). Requires guardCheckGateway + tutorChatGateway.
- * Without them, callGateway() surfaces a friendly "backend not configured" error rather than
- * failing silently.
+ * Tutor workflow mode pipeline (Option B).
+ * guardCheckGateway and tutorChatGateway are required — the factory must not construct
+ * this use case unless both gateways are available.
```

---

### 2. `tyla/src/infrastructure/bootstrap/agent-factory.ts`

`getProfile()` already determines both gateways together — they are always either both
defined or both `undefined`. Gate on `profile` directly so the condition is single-source:

```diff
+const profile = getProfile(directory);
-const tutorChatGateway = getProfile(directory)
+const tutorChatGateway = profile
     ? new TutorChatGateway((msg) => emit('status_update', { warning: msg }), directory)
     : undefined;
-const guardCheckGateway = getProfile(directory)
+const guardCheckGateway = profile
     ? new GuardCheckGateway((msg) => emit('status_update', { warning: msg }), directory)
     : undefined;

-const tutorUseCase = new ExecuteTutorUseCase({
-    registry, directory, emit, policyLoader: assignmentPolicyLoader,
-    tutorChatGateway, guardCheckGateway,
-    onApproval: approvalBus.approve.bind(approvalBus),
-    diffEngine,
-});
+const tutorUseCase = profile
+    ? new ExecuteTutorUseCase({
+          registry, directory, emit, policyLoader: assignmentPolicyLoader,
+          tutorChatGateway: tutorChatGateway!,
+          guardCheckGateway: guardCheckGateway!,
+          onApproval: approvalBus.approve.bind(approvalBus),
+          diffEngine,
+      })
+    : null;
```

> The `!` non-null assertions are sound here because TypeScript cannot yet narrow through
> `profile ?` to prove both gateway vars are defined. They disappear if the gateway
> constructions are inlined inside the ternary instead.

---

### 3. `tyla/src/application/services/agent-service.ts`

**a) Make `tutorUseCase` nullable in `AgentServiceDeps` (L122)**

```diff
-    tutorUseCase: ExecuteTutorUseCase;
+    tutorUseCase: ExecuteTutorUseCase | null;
```

**b) Same for the private field (L156)**

```diff
-    private readonly tutorUseCase: ExecuteTutorUseCase;
+    private readonly tutorUseCase: ExecuteTutorUseCase | null;
```

**c) Add a null check before `.execute()` (inside the `if (mode !== 'default')` block, L270)**

`executeInstruction` routes via an `if`-block, not a `switch`. The diff applies inside
that block:

```diff
 if (mode !== 'default') {
+    if (!this.tutorUseCase) {
+        this.emit({ type: 'error', data: { message: 'Tutor backend not configured — set a valid profile.json and restart tyla.', phase: 'guard' } });
+        return;
+    }
     let result;
     try {
         result = await this.tutorUseCase.execute(instruction, history);
```

> `this.emit()` takes an `AgentEvent` object — not the two-arg `(type, data)` form used
> by the raw `EmitFn` inside use cases.

---

## What Does NOT Change

- `TutorChatGateway` and `GuardCheckGateway` themselves — infrastructure unchanged.
- The friendly error message — same text, now lives in `agent-service.ts`.
- All other use cases — no cascading changes.

---

## Test Changes Required

### Pre-existing arity mismatch (fix before Step 1)

Every test in `tests/unit/application/execute-tutor-use-case.test.ts` calls
`new ExecuteTutorUseCase(deps, 'tutor-guide')` with a second argument that the current
constructor does not accept. TypeScript should already be flagging this. Investigate and
resolve **before** making the gateways required, or Step 4 (`bun run build`) will conflate
this pre-existing error with the refactor.

### Delete the Phase 0 test

The test `'throws a friendly error (not a TypeError) when the guard gateway is absent'`
(line 76) exists specifically to verify the Phase 0 guard behavior being deleted. It must
be **removed**, not updated — providing mock gateways would change its intent without
testing anything useful.

### Add a replacement test in `agent-service.test.ts`

Add a test that passes `tutorUseCase: null` in `AgentServiceDeps`, calls
`executeInstruction` with a non-default mode, and asserts that an `error` event is emitted
with the "backend not configured" message. This covers the same scenario at its new,
correct layer.

---

## Execution Order

1. Investigate and fix the pre-existing constructor arity mismatch in the test file.
2. Change `ExecuteTutorDeps` (required fields) + delete Phase 0 in use case.
3. Update `agent-factory.ts` (conditional construction, gate on `profile`).
4. Update `agent-service.ts` (nullable field + null check).
5. Run `cd tyla && bun run build` — expect zero TypeScript errors.
6. Update tests: delete the Phase 0 guard test; add the `AgentService` null-check test.
7. Run `bun run test` — expect all tests to pass.
