# Tyla CLI — Data Flow Sequence Diagram

> **Version:** 1.0  
> **Date:** 2026-05-12

---

## Login Flow

```mermaid
sequenceDiagram
    actor Student
    participant TUI
    participant Google as Google OAuth
    participant API as Tyto API
    participant FS as Local Filesystem

    Student->>TUI: tyla login

    rect rgb(218, 232, 252)
        note over TUI,Google: ① PKCE Authorization
        TUI->>Google: PKCE authorize (scope: openid email profile)
        Google-->>TUI: access_token
    end

    rect rgb(218, 232, 252)
        note over TUI,API: ② Token Verification
        TUI->>API: POST /auth/verify_google_token<br/>{ accessToken }
        API-->>TUI: { student, auth, courses[] }
        TUI->>FS: write ~/.tyla/auth.json<br/>{ token, expiresAt }
    end

    rect rgb(255, 230, 204)
        note over TUI: ③ Course Selection (local)
        alt Single course
            TUI->>TUI: auto-select course
        else Multiple courses
            TUI->>Student: render TUI Picker (↑/↓ + Enter)
            Student->>TUI: select course
        end
    end

    rect rgb(218, 232, 252)
        note over TUI,API: ④ Fetch Assignment Context
        TUI->>API: GET /account/current_context?courseId<br/>[Authorization: Bearer token]
        alt currentAssignment is null
            API-->>TUI: { selectedCourse, currentAssignment: null }
            TUI-->>Student: ⚠️ No active assignment — login complete
        else currentAssignment exists
            API-->>TUI: { selectedCourse, currentAssignment }
            TUI->>FS: write ./.ai-tutor-config<br/>{ student, auth, selectedCourse, currentAssignment }
        end
    end

    rect rgb(218, 232, 252)
        note over TUI,API: ⑤ Download Assignment Package
        TUI->>API: GET /assignments/:id/package<br/>[Authorization: Bearer token]
        API-->>TUI: ZIP (binary)
        TUI->>FS: unpack to ./assignments/<courseId>-<id>/
        note over FS: student-files/ → plaintext<br/>tutors/       → plaintext<br/>notes/        → plaintext<br/>assignment/   → plaintext<br/>solutions/    → encrypted 🔒
    end

    TUI-->>Student: Login complete ✓
```

---

## Question Flow

> Corresponds to **Section 4** of the API spec: `GET /assignments/:assignmentId/documents`

```mermaid
sequenceDiagram
    actor Student
    participant TUI
    participant API as Tyto API
    participant LLM as GitHub LLM API

    Student->>TUI: ask question
    note over TUI: read assignmentId from ./.ai-tutor-config<br/>(currentAssignment.id — set at login ④, used in ⑤)

    rect rgb(255, 230, 204)
        note over TUI,API: ⑥ Fetch Decrypted Documents (server-side decrypt)
        TUI->>API: GET /assignments/:assignmentId/documents<br/>?types=hw,solutions,notes<br/>[Authorization: Bearer token]
        note over API: decrypt solutions/ server-side 🔓
        API-->>TUI: { documents: [hw, solutions, notes] }<br/>(plaintext — held in memory only)
        note over TUI: ⚠️ never written to disk
    end

    rect rgb(255, 230, 204)
        note over TUI,LLM: ⑦ LLM Inference
        TUI->>LLM: LLM key + context + documents + question
        LLM-->>TUI: AI response (streamed)
    end

    TUI-->>Student: display answer (streamed)
```

---

## Combined Overview

```mermaid
sequenceDiagram
    actor Student
    participant TUI
    participant Google as Google OAuth
    participant API as Tyto API
    participant FS as Local Filesystem
    participant LLM as GitHub LLM API

    Student->>TUI: tyla login

    TUI->>Google: ① PKCE authorize
    Google-->>TUI: access_token

    TUI->>API: ② POST /auth/verify_google_token
    API-->>TUI: { student, auth, courses[] }
    TUI->>FS: write ~/.tyla/auth.json

    alt Multiple courses
        TUI->>Student: ③ TUI Picker
        Student->>TUI: select course
    end

    TUI->>API: ④ GET /account/current_context?courseId<br/>[Bearer token]
    alt currentAssignment is null
        API-->>TUI: { selectedCourse, currentAssignment: null }
        TUI-->>Student: ⚠️ No active assignment
    else currentAssignment exists
        API-->>TUI: { selectedCourse, currentAssignment }
        TUI->>FS: write ./.ai-tutor-config<br/>{ student, auth, selectedCourse, currentAssignment }

        TUI->>API: ⑤ GET /assignments/:id/package<br/>[Bearer token]
        API-->>TUI: ZIP
        TUI->>FS: unpack ./assignments/<courseId>-<id>/

        TUI-->>Student: Login complete ✓
    end

    loop Each question
        Student->>TUI: ask question

        TUI->>API: ⑥ GET /assignments/:id/documents
        note over API: decrypt solutions/ server-side
        API-->>TUI: { documents } (memory only)

        TUI->>LLM: ⑦ key + context + documents
        LLM-->>TUI: AI response (streamed)
        TUI-->>Student: display answer
    end
```
