# Plan — Revise API Spec (CLI × Tyto Backend)

> **Date:** 2026-05-16  
> **Target file:** `plans/2026-05-12-api-spec-cli-google-auth.md`

## Background

Based on clarified usage pattern:
- One folder per assignment (weekly cadence)
- Student sets up once at the start of the week, then uses the same folder daily
- `GET /current_context` is only needed once per setup — not a recurring call

## Changes

### 1. Merge `GET /current_context` into `GET /package`

`/current_context` and `/package` are always called together during setup and never independently. Merge the assignment metadata into the `/package` response to reduce setup from 3 API calls to 2.

**Before (3 calls on setup):**
1. `POST /auth/verify_google_token`
2. `GET /account/current_context?courseId=:courseId`
3. `GET /assignments/:assignmentId/package`

**After (2 calls on setup):**
1. `POST /auth/verify_google_token` — returns `{ student, auth, courses[] }`
2. `GET /assignments/:assignmentId/package?courseId=:courseId` — returns ZIP + assignment metadata in headers or a companion JSON

> **Open question:** how to return metadata alongside a binary ZIP response — options:
> - Response headers (e.g. `X-Assignment-Meta: {...}`)
> - Separate JSON body with a signed URL for the ZIP download
> - Multipart response

### 2. Clarify call frequency for each API

Add a "when called" column or note to each endpoint so tyto and tyla both have a shared mental model.

| Endpoint | Called when |
|----------|-------------|
| `POST /auth/verify_google_token` | Once per login (JWT reused until expiry) |
| `GET /assignments/:assignmentId/package` | Once per assignment setup (start of week) |
| `GET /assignments/:assignmentId/documents` | Every time student asks a question |

### 3. Add CLI responsibilities section

Current spec only describes what tyto returns. Add a short section listing what tyla is responsible for, so the boundary is explicit:

- PKCE OAuth 2.0 flow with Google (tyla handles entirely)
- Local state: `~/.tyla/auth.json` (JWT), `./.ai-tutor-config` (assignment context)
- Skip `/package` download if local folder already exists for this assignment
- Never write `solutions` content to disk

## Out of scope (unchanged)

- `GET /assignments/:assignmentId/documents` — no changes needed
- Error response formats — keep as-is
- Auth token refresh — still out of scope
