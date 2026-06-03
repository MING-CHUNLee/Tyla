# Guard Check API Integration Plan

**Date:** 2026-05-21  
**Endpoint:** `POST /api/v1/guard_checks`  
**Spec:** `Tyla-api/doc/api_guard_checks.md`

---

## Goal

Before forwarding a student's prompt to the tutor LLM, MindyCLI sends it to the Tyla-api guard endpoint.  
The backend runs an LLM judge and returns `{ allowed, attack_probability, evaluation }`.  
MindyCLI acts on `allowed`: proceed → tutor pipeline; blocked → display `refusal` to student.

---

## Current State

| File | Status | Notes |
|------|--------|-------|
| `tyla/src/infrastructure/api/guard/` | New (untracked) | HTTP transport to `POST /api/v1/guard_checks` |
| `tyla/src/infrastructure/config/profile.ts` | Exists | `getProfile()` reads `<cwd>/.tyla/profile.json` |
| `tyla/src/infrastructure/config/settings.ts` | Exists | `getSettings()` — currently used for identity fields (should not be) |
| `tyla/src/infrastructure/config/constants.ts` | Modified | `TYLA_API` block added (`HOST`, `PORT`, `DEFAULT_TIMEOUT_MS`) |
| `tyla/src/infrastructure/bootstrap/agent-factory.ts` | Modified | Constructs `GuardCheckGateway` and injects into `ExecuteTutorUseCase` |

---

## Data Sources

### LLM Credentials — from `.env`

| Header | Source | `.env` key |
|--------|--------|------------|
| `X-LLM-Key` | `getApiKeyForProvider(provider)` | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / … |
| `X-LLM-Provider` | `detectProvider()` | `LLM_PROVIDER` (auto-detected from available keys if absent) |
| `X-LLM-Model` | `getEnv(ENV_VARS.LLM_MODEL)` | `LLM_MODEL` |
| `X-LLM-Endpoint` | `getEndpointForProvider(provider)` | `OPENAI_API_BASE` (for GitHub Models path) |

**GitHub Models example `.env`:**
```
LLM_PROVIDER=openai
OPENAI_API_KEY=github_pat_xxxxxxxxxxxxxxxxxxxx
LLM_MODEL=gpt-4o
OPENAI_API_BASE=https://models.inference.ai.azure.com/chat/completions
```

### Student Identity — from `profile.json`

File location: `<cwd>/.tyla/profile.json`

```json
{
  "studentId":  "stu-abc",
  "courseId":   "CS101",
  "projectId":  "proj-1"
}
```

Read via `getProfile()` from `infrastructure/config/profile.ts`.  
Map to snake_case for the request body: `studentId` → `student_id`, etc.

> **Important:** Identity fields must come from `profile.json` via `getProfile()`, **not** from `settings.json` via `getSettings()`.  
> The current `GuardCheckGateway` incorrectly reads `settings.courseId` — this must be fixed.

---

## Request Shape

```
POST <TYLA_API_HOST>:<TYLA_API_PORT>/api/v1/guard_checks
Content-Type:   application/json
X-LLM-Key:      <apiKey>
X-LLM-Provider: <provider>
X-LLM-Model:    <model>
X-LLM-Endpoint: <endpoint>

{
  "course_id":  "CS101",
  "project_id": "proj-1",
  "student_id": "stu-abc",
  "prompt":     "<raw student message>"
}
```

---

## Response Handling

| HTTP Status | Condition | MindyCLI Action |
|-------------|-----------|-----------------|
| `200` + `allowed: true` | Prompt safe | Forward to tutor pipeline |
| `200` + `allowed: false` | Prompt blocked | Display `refusal` field; abort turn |
| `202` | LLM judge unavailable (fail-open) | Continue tutor flow; log `warning` internally |
| `4xx` / `5xx` | Backend or validation error | Emit error event; surface message to student |

---

## Implementation Checklist

### 1. Fix identity source in `GuardCheckGateway`

**File:** `tyla/src/infrastructure/api/guard/guard-check-gateway.ts`

- [ ] Replace `getSettings()` call with `getProfile()` from `infrastructure/config/profile.ts`
- [ ] If `getProfile()` returns `null`, emit warning and return `{ allowed: true, reason: 'profile-missing' }`
- [ ] Map camelCase profile fields → snake_case body fields:
  ```ts
  const profile = getProfile();
  // body: { course_id: profile.courseId, project_id: profile.projectId, student_id: profile.studentId }
  ```

### 2. Verify LLM credential resolution

**File:** `tyla/src/infrastructure/api/guard/guard-check-gateway.ts`

- [ ] `detectProvider()` correctly reads `LLM_PROVIDER` env var (or auto-detects)
- [ ] `getApiKeyForProvider(provider)` throws when key is missing → catch and fail-open with warning
- [ ] `getEndpointForProvider(provider)` returns `OPENAI_API_BASE` when set (GitHub Models path)
- [ ] `getEnv(ENV_VARS.LLM_MODEL)` may return `undefined` → send empty string (backend falls back to `gpt-4o-mini`)

### 3. Verify `TYLA_API` constants

**File:** `tyla/src/infrastructure/config/constants.ts`

- [ ] `TYLA_API.HOST` reads `TYLA_API_HOST` env var (default `localhost`)
- [ ] `TYLA_API.PORT` reads `TYLA_API_PORT` env var (default `3000`)
- [ ] `TYLA_API.DEFAULT_TIMEOUT_MS` is `60_000` (LLM judge can be slow)

### 4. Wire into tutor pipeline (already done — verify)

**File:** `tyla/src/infrastructure/bootstrap/agent-factory.ts`

- [ ] `GuardCheckGateway` is constructed with `onJudgeError` and `onLog` callbacks
- [ ] Injected into `ExecuteTutorUseCase` via `guardAgent` dep
- [ ] `appendGuardLog` callback wires to `guard-log-repository`

### 5. Guard log persistence

**File:** `tyla/src/infrastructure/persistence/guard-log-repository.ts`

- [ ] `appendGuardLog(entry)` writes to `<cwd>/.tyla/guard-log.json`
- [ ] Log path provided by `getGuardLogFile()` from `infrastructure/config/paths.ts`

---

## Data Flow Diagram

```
Student types prompt
        │
        ▼
ExecuteTutorUseCase.execute(prompt)
        │
        ▼
GuardCheckGateway.check(prompt)
  ├─ Read LLM creds    ← .env (detectProvider, getApiKeyForProvider, getEndpointForProvider)
  ├─ Read identity     ← <cwd>/.tyla/profile.json (getProfile)
  └─ POST /api/v1/guard_checks ──────────────► Tyla-api
                                                │  LLM judge
                                                │  INSERT prompt_logs
                                               ◄─ { allowed, attack_probability, evaluation }
        │
        ├─ allowed: true  ──────────────────► Tutor LLM pipeline continues
        └─ allowed: false ──────────────────► Display refusal; abort turn
```

---

## Files Touched

| File | Change |
|------|--------|
| `infrastructure/api/guard/guard-check-gateway.ts` | Fix: use `getProfile()` instead of `getSettings()` |
| `infrastructure/config/profile.ts` | No change (already correct) |
| `infrastructure/config/constants.ts` | Verify `TYLA_API` block |
| `infrastructure/persistence/guard-log-repository.ts` | Verify `appendGuardLog` |
| `infrastructure/bootstrap/agent-factory.ts` | Verify wiring |

---

## Out of Scope

- Authentication / login flow (separate plan: `2026-05-10-authxn-tyla-tyto-google-sso.md`)
- Backend implementation of `POST /api/v1/guard_checks` (Tyla-api side)
- Changing the threshold (0.7) — that lives on the backend
