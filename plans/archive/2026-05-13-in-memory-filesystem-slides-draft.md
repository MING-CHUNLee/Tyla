# Slide Draft — In-Memory Filesystem & Recommended Combination

---

## Page 2 — Candidates Library for In-Memory Filesystem

### What we need

After unzipping, `solution.R` must live in a controlled, isolated space that:
- Is never accessible via the real filesystem
- Supports standard read/write operations so existing code paths work unchanged
- Can be cleared entirely when the session ends

---

### `memfs`  ✅ Recommended

A complete in-memory filesystem for Node.js that is API-compatible with the built-in `fs` module.

**Pros**
- Drop-in replacement for Node's `fs` — no refactoring needed in existing tool code
- Supports the full `fs` API: `readFileSync`, `writeFileSync`, `mkdirSync`, `readdirSync`, etc.
- Volume (`vol`) can be reset with a single `vol.reset()` call — clean teardown at session end
- Well-maintained, widely used in testing and tooling ecosystems
- Works in Bun (Node.js-compatible runtime)

**Cons**
- Adds one dependency (~50 KB)
- In-memory data is still accessible via process memory dump (accepted trade-off for our threat model)

---

### `mock-fs` ❌ Not recommended

Patches the real `fs` module globally at the process level.

**Why excluded:** Designed exclusively for unit testing. Global patching causes unpredictable side effects in a long-running CLI process and is explicitly documented as unsuitable for production use.

---

### `@zip.js/zip.js` ❌ Not recommended

A zip library with a built-in virtual filesystem layer.

**Why excluded:** Primarily designed for browser environments. Its virtual fs is tightly coupled to its own zip reader API, requiring full migration away from `fflate`. The extra coupling is not justified given `memfs` solves the filesystem layer independently.

---

### `unionfs` ❌ Out of scope

Allows overlaying a virtual `memfs` volume on top of the real filesystem, so code sees both.

**Why excluded:** Useful when you need transparent fallthrough to real files, but our use case is the opposite — we want `solution.R` to be *invisible* to the real filesystem. `memfs` alone is sufficient and simpler.

---

### Summary

| Library | Node/Bun compatible | Production-safe | `fs` API compatible | Verdict |
|---------|-------------------|-----------------|---------------------|---------|
| `memfs` | ✅ | ✅ | ✅ | **Use this** |
| `mock-fs` | ✅ | ❌ | ✅ | Testing only |
| `@zip.js/zip.js` | Partial | ✅ | ❌ | Browser-first |
| `unionfs` | ✅ | ✅ | ✅ | Out of scope |

`memfs` is the only library that satisfies all three requirements for a production CLI.

---

## Page 3 — Recommended Combination: `fflate` + `memfs`

### Why this pair

| Concern | How it is addressed |
|---------|-------------------|
| Decompression speed | `fflate` is 2–3× faster than jszip |
| Bundle size | `fflate` ~30 KB + `memfs` ~50 KB — well under jszip alone at ~100 KB |
| Secret isolation | `memfs` volume holds `solution.R`; real `fs` never touches it |
| Session cleanup | `vol.reset()` wipes all in-memory files at logout |
| Code compatibility | `memfs` `fs`-compatible API requires no changes to existing tool code |

---

### Data Flow

```
Backend
  └─ Encrypted assignment.zip  ──(HTTPS + packageToken)──►  Tyla CLI
                                                                │
                                                          AES-GCM decrypt
                                                                │
                                                         fflate.unzipSync()
                                                                │
                                              ┌─────────────────────────────┐
                                              │                             │
                                        solution.R                 starter.R  /  spec.pdf
                                              │                             │
                                        memfs vol                     real disk
                                    (memory-only, never                (student's
                                     written to disk)                  workspace)
                                              │
                                       AI prompt builder
                                    (reads from memfs only)
```

---

### Code Sketch

```typescript
import { unzipSync } from 'fflate'
import { vol, fs as memFs } from 'memfs'
import { fs } from 'fs'
import { decrypt } from '../crypto/aes-gcm'

export function loadAssignmentPackage(
  encryptedZip: Buffer,
  key: Buffer,
  workDir: string
): void {
  // 1. Decrypt
  const zipBytes = decrypt(encryptedZip, key)

  // 2. Unzip entirely in memory
  const files = unzipSync(new Uint8Array(zipBytes))

  // 3a. Public files → real disk (student workspace)
  fs.writeFileSync(`${workDir}/hw.R`,    Buffer.from(files['starter.R']))
  fs.writeFileSync(`${workDir}/spec.pdf`, Buffer.from(files['spec.pdf']))

  // 3b. Secret file → memfs only (never touches disk)
  vol.mkdirSync('/session', { recursive: true })
  vol.writeFileSync('/session/solution.R', Buffer.from(files['solution.R']))
}

// Reading the secret later (inside prompt builder)
export function getSolution(): string {
  return memFs.readFileSync('/session/solution.R', 'utf8') as string
}

// Cleanup on logout
export function clearSession(): void {
  vol.reset()
}
```

---

### Security Trade-offs (honest assessment)

| Attack vector | Mitigated? | Notes |
|---------------|-----------|-------|
| Find file on disk | ✅ Yes | `solution.R` never written to real filesystem |
| Read from `node_modules` or temp dirs | ✅ Yes | `fflate` + `memfs` never call real `fs.writeFile` |
| Network interception (MITM) | ✅ Partial | `packageToken` is short-lived; HTTPS encrypts transport |
| Process memory dump | ❌ No | Accepted — target users are students, not red-teamers |
| Node.js `--inspect` debugger | ❌ No | Accepted — same rationale |

This combination raises the barrier high enough for the intended threat model (students seeking shortcuts) without requiring a full server-side prompt assembly architecture.
