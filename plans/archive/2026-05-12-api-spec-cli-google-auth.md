# API Specification — Tyla CLI × Tyto Backend (Google OAuth)

> **Version:** 1.2  
> **Date:** 2026-05-16  
> **Base URL:** `https://<tyto-host>/api`

---

## Authentication

The CLI uses the **OAuth 2.0 + PKCE** flow against Google and exchanges the resulting `access_token` with Tyto.

All subsequent requests must include the JWT returned from the login endpoint:

```
Authorization: Bearer <token>
```

---


## CLI Responsibilities

The following concerns are handled entirely by tyla (not tyto):

- **PKCE OAuth 2.0 flow** — tyla initiates the Google authorization, handles the redirect, and exchanges the code for an `access_token`.
- **Local auth state** — JWT and expiry are persisted to `~/.tyla/auth.json`; this token is reused until expiry.
- **Assignment context** — `./.ai-tutor-config` stores `{ student, auth, selectedCourse, currentAssignment }` after setup.
- **Skip redundant downloads** — if `./assignments/<courseId>-<assignmentId>/` already exists on disk, tyla skips the `GET /package` call.
- **Solutions isolation** — the CLI calls `GET /assignments/:id/documents/token` to obtain a short-lived decryption key, decrypts the local `solutions/` files **in memory**, and passes the plaintext to the LLM. Decrypted content is **never** written to disk.

---

## Endpoints

### 1. Verify Google Token (Login)

> **When called:** Once per login session. The returned JWT is reused until `expiresAt`.

![Login Flow](./img/Login%20Flow.drawio.png)

Exchange a Google `access_token` for a Tyto JWT and initial workspace context.

```
POST /auth/verify_google_token
```

**Request**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `accessToken` | string | yes | Google OAuth `access_token` obtained via PKCE flow |

```json
{
  "accessToken": "ya29...."
}
```

> **Note:** The CLI must request scopes `openid email profile` when initiating the PKCE flow.

**Response — 200 OK**

```json
{
  "student": {
    "id": "s110001",
    "email": "student@edu.tw",
    "displayName": "Ming-Chun Lee"
  },
  "auth": {
    "token": "eyJhbGc...",
    "expiresAt": "2026-05-07T00:00:00Z"
  },
  "courses": [
    { "id": "CS101", "name": "Foundation of Programming" },
    { "id": "CS201", "name": "Data Structures" },
    { "id": "EE305", "name": "Computer Architecture" }
  ]
}
```

The CLI handles course selection locally:
- **Single course** — auto-select, proceed immediately.
- **Multiple courses** — render TUI picker; user navigates with ↑/↓ and confirms with Enter.

After selection the CLI writes `~/.tyla/auth.json` and calls `GET /assignments/:assignmentId/package?courseId=:courseId` to fetch the assignment package and metadata in one request.

**Field Reference — `student`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Student identifier |
| `email` | string | Email address from Google account |
| `displayName` | string | Full name from Google account |

**Field Reference — `auth`**

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | Tyto JWT for all subsequent API calls |
| `expiresAt` | string (ISO 8601) | Token expiry timestamp (UTC) |

**Field Reference — `courses[]`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Course identifier (e.g. `"CS201"`) |
| `name` | string | Human-readable course name |

**Error Responses**

| Status | Body | When |
|--------|------|------|
| 401 | `{ "error": "Invalid or missing token" }` | Google token invalid or expired |
| 404 | `{ "error": "No enrolled course" }` | Account exists but is not enrolled in any course |

---

### 2. Download Assignment Package

> **When called:** Once per assignment setup (start of week). Skipped if the local folder already exists.

![Download Assignment Package](./img/Download%20Assignment%20Package.drawio.png)

Download the assignment ZIP for the active assignment. Assignment metadata is bundled inside the ZIP as `metadata.json`.

```
GET /assignments/:assignmentId/package?courseId=:courseId
```

**Path Parameter**

| Parameter | Description |
|-----------|-------------|
| `assignmentId` | Assignment identifier (e.g. `HW2`) |

**Query Parameter**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `courseId` | string | yes | Course identifier chosen by the CLI (e.g. `CS201`) |

**Request Headers**

```
Authorization: Bearer <token>
```

**Response — 200 OK**

```
Content-Type: application/zip
Content-Disposition: attachment; filename="CS201-HW2.zip"

<binary ZIP content>
```

The ZIP unpacks directly to the local working directory. Paths are relative to `assignments/`:

```
assignments/
└── CS201-HW2/
    ├── metadata.json    ← CLI reads this first to populate .ai-tutor-config
    ├── student-files/   ← plaintext — student reads and edits these
    ├── tutors/          ← plaintext — tutor policy files (socratic.md, guide.md, …)
    ├── notes/           ← plaintext — class handouts
    ├── assignment/      ← plaintext — spec documents (HW2.md / HW2.tex)
    └── solutions/       ← encrypted — CLI decrypts in memory using key from GET /documents/token; never written to disk
```

**`metadata.json` schema**

```json
{
  "courseId": "CS201",
  "courseName": "Data Structures",
  "id": "HW2",
  "title": "Homework 2",
  "dueAt": "2026-05-07T23:59:00+08:00",
  "mode": "tutor-guide",
  "starterFile": "CS201-HW2/student-files/student01.Rmd",
  "specFile": "CS201-HW2/assignment/HW2.md",
  "submissionEndpoint": "https://api.example.com/submit"
}
```

`starterFile` and `specFile` are paths relative to `assignments/`. After unpacking, the CLI reads `metadata.json` and writes `.ai-tutor-config`.

The CLI must **not** attempt to decrypt `solutions/` on disk. In-memory decryption uses the short-lived key obtained from `GET /assignments/:assignmentId/documents/token`.

**Field Reference — `metadata.json`**

| Field | Type | Description |
|-------|------|-------------|
| `courseId` | string | Course identifier |
| `courseName` | string | Human-readable course name |
| `id` | string | Assignment identifier (e.g. `"HW2"`) |
| `title` | string | Human-readable assignment name |
| `dueAt` | string (ISO 8601) | Due date with timezone |
| `mode` | enum | LLM tutoring policy: `"tutor-socratic"` / `"tutor-guide"` |
| `starterFile` | string | Path relative to `assignments/` |
| `specFile` | string | Path relative to `assignments/` |
| `submissionEndpoint` | string | Full URL the CLI POSTs the submission to |

**Error Responses**

| Status | Body | When |
|--------|------|------|
| 401 | `{ "error": "Invalid or missing credential" }` | Missing or expired token |
| 403 | `{ "error": "Not enrolled in this assignment" }` | Student not enrolled |
| 404 | `{ "error": "Assignment not found" }` | Invalid `assignmentId` or `courseId` |

---

### 3. Request Solutions Decryption Token (for LLM context)

> **When called:** Once per session (or when the cached token is within 5 minutes of expiry). The CLI caches the token in memory and reuses it for all questions in the same session.

![Request Solutions Decryption Token](./img/Request%20Solutions%20Decryption%20Token.drawio.png)

Obtain a short-lived decryption token scoped to `(studentId, assignmentId)`. The CLI uses this token to decrypt the local `solutions/` files in memory and pass their contents as LLM context. Plaintext files (`hw`, `notes`) are read directly from the local ZIP — they do not go through this endpoint.

```
GET /assignments/:assignmentId/documents/token
```

**Path Parameter**

| Parameter | Description |
|-----------|-------------|
| `assignmentId` | Assignment identifier (e.g. `HW2`) — read from `.ai-tutor-config` → `currentAssignment.id` |

**Request Headers**

```
Authorization: Bearer <token>
```

**Response — 200 OK**

```json
{
  "decryptionKey": "<base64-encoded-key>",
  "expiresAt": "2026-05-16T15:30:00Z",
  "algorithm": "AES-256-GCM"
}
```

**Security model**

- The decryption key is scoped to `(studentId, assignmentId)` with a 1-hour TTL. The same key is returned for repeated calls within the TTL window; a new key is issued after expiry.
- The CLI caches `{ decryptionKey, expiresAt }` in memory. Before each LLM call it checks the remaining TTL — if under 5 minutes, it silently re-fetches before decrypting.
- The decryption key must **not** be persisted to disk. Decrypted `solutions/` content must **not** be written to disk.

**Error Responses**

| Status | Body | When |
|--------|------|------|
| 401 | `{ "error": "Invalid or missing credential" }` | Missing or expired token |
| 403 | `{ "error": "Not enrolled in this assignment" }` | Student not enrolled |
| 404 | `{ "error": "Assignment not found" }` | Invalid `assignmentId` |

---

## CLI Local State After Setup

The CLI persists setup results to two locations:

| Path | Content | Purpose |
|------|---------|---------|
| `~/.tyla/auth.json` | `{ "token": "...", "expiresAt": "..." }` | JWT reused for all future API calls |
| `./.ai-tutor-config` | `{ student, auth, selectedCourse, currentAssignment }` — populated from login (step 1) and `metadata.json` inside the ZIP (step 2) | Per-project context; different directories can have different assignments |
| `./assignments/<course>-<id>/` | Unpacked ZIP contents (student-files/, tutors/, notes/, assignment/, solutions/) | Student working directory |

> `.ai-tutor-config` is project-scoped so that different working directories can represent different course environments.

---

## Question Flow

```
CLI                         Google        Tyto Backend      GitHub LLM API
 │                              │               │                  │
 │  ── setup (once per assignment) ───────────  │                  │
 │── PKCE authorize ────────────►               │                  │
 │◄─ access_token ─────────────┘               │                  │
 │                                              │                  │
 │── POST /auth/verify_google_token ──────────► │                  │
 │◄─ { student, auth, courses[] } ────────────  │                  │
 │  [write ~/.tyla/auth.json]                   │                  │
 │                                              │                  │
 │  [single course]  → auto-select              │                  │
 │  [multiple courses] → TUI picker             │                  │
 │                                              │                  │
 │── GET /assignments/:id/package?courseId ───► │                  │
 │◄─ <binary ZIP> ─────────────────────────────  │                  │
 │  [unpack to ./assignments/<courseId>-<id>/]  │                  │
 │  [read metadata.json → write .ai-tutor-config]               │
 │  student-files/ notes/ assignment/ → plaintext               │
 │  solutions/ → encrypted blob (cannot open)  │                  │
 │                                              │                  │
 │  ── student asks a question ──────────────────────────────────  │
 │── GET /assignments/:id/documents/token ────► │                  │
 │   [Authorization: Bearer token]              │                  │
 │   [assignmentId from .ai-tutor-config]       │                  │
 │◄─ { decryptionKey, expiresAt, algorithm } ─  │                  │
 │  [decrypt solutions/ in memory]              │                  │
 │  [read student-files/ notes/ assignment/ from disk — plaintext] │
 │  [hold all content in memory, never write to disk]              │
 │                                              │                  │
 │── LLM key + context + documents + question ────────────────────►│
 │◄─ AI response (streamed) ──────────────────────────────────────  │
```

---

## Out of Scope (this version)

- `id_token` / JWT / JWKS verification on the backend
- Refresh tokens or silent re-auth (CLI re-runs login when token expires)
- Persisting selected course on the backend (selection is CLI-local only)
- Conditional ZIP download (e.g. `If-None-Match` / version check)
- `GET /account/current_context` — removed in v1.2 (merged into `GET /package`)
