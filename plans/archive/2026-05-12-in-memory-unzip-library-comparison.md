# In-Memory ZIP Library Comparison for Tyla CLI

> **Date:** 2026-05-12
> **Context:** Stage 3 — Encrypted assignment package download
> **Question:** Which TypeScript library should we use to unzip an assignment package into memory (never writing sensitive files to disk)?

---

## Background

When a student launches Tyla CLI, it downloads an encrypted `assignment.zip` from the backend. The zip contains three file types with different visibility requirements:

| File | Student sees it? | Write to disk? |
|------|-----------------|----------------|
| `starter_file` (e.g. `hw2.R`) | Yes | Yes |
| `spec.pdf` | Yes | Yes |
| `solution.R` (reference answer) | **No** | **No — memory only** |

The reference answer must be kept in memory and injected directly into the AI prompt. Writing it to disk — even temporarily — creates an obvious path for students to find it in the filesystem.

---

## Candidates

### 1. `fflate`

A fast, pure-JS compression library with a synchronous and callback-based async API. Decompresses directly to `Uint8Array` buffers with no filesystem involvement.

```typescript
import { unzip } from 'fflate'

unzip(encryptedBytes, (err, files) => {
  // files: Record<string, Uint8Array>
  const solution = new TextDecoder().decode(files['solution.R'])
  // → pass to AI prompt; never call fs.writeFileSync on this
  const starter  = files['hw2.R']
  fs.writeFileSync('hw2.R', starter)
})
```

**Pros**
- Fastest JS implementation (benchmarks: 2–3× faster than jszip)
- Smallest bundle size (~30 KB gzipped vs. jszip ~100 KB)
- Zero dependencies
- Works identically in Node.js and browser environments
- Synchronous variant (`unzipSync`) available for simpler control flow

**Cons**
- Lower-level API; caller must handle file-by-file logic manually
- No built-in streaming for very large zips (not a concern at assignment scale)

---

### 2. `jszip`

A widely-used library with a higher-level, Promise-based API. Loads the entire zip into an in-memory object and lets callers read individual entries as strings, `Buffer`, or `Uint8Array`.

```typescript
import JSZip from 'jszip'

const zip = await JSZip.loadAsync(encryptedBytes)
const solution = await zip.file('solution.R')!.async('string')
const starter  = await zip.file('hw2.R')!.async('nodebuffer')
fs.writeFileSync('hw2.R', starter)
```

**Pros**
- Intuitive, Promise-based API — less boilerplate per file
- Well-documented with a large community
- Supports both reading and writing zips (useful if we need to create submission packages later)

**Cons**
- Significantly larger bundle (~100 KB gzipped)
- Slower decompression (relevant if package size grows)
- Extra dependency weight for functionality we may not need

---

### 3. `fflate` + `memfs` (virtual filesystem layer)

`memfs` provides an in-memory filesystem that is API-compatible with Node's `fs` module. Combined with `fflate`, extracted files can be mounted into a virtual volume. Code that uses standard `fs.readFileSync` paths can then access in-memory files without any changes.

```typescript
import { unzipSync } from 'fflate'
import { vol } from 'memfs'

const files = unzipSync(encryptedBytes)
vol.fromBuffer(
  Object.fromEntries(
    Object.entries(files).map(([p, d]) => [p, Buffer.from(d)])
  )
)
// Existing fs.readFileSync('/solution.R') calls work unchanged
```

**Pros**
- `fs`-compatible interface — zero refactoring if other modules already use `fs` paths
- Useful if tool plugins or the R adapter read files via `fs` internally

**Cons**
- Two libraries instead of one
- Additional abstraction layer increases debugging surface area
- Unnecessary if callers can accept `Uint8Array` / `string` directly

---

## Recommendation

**Use `fflate` alone.**

Tyla CLI already passes file content as strings/buffers between modules (see `file-read-tool.ts` and `execute-instruction-use-case.ts`). There is no existing code path that requires a `fs`-compatible interface for in-memory content, so `memfs` adds complexity without benefit.

`fflate` gives the smallest footprint and the fastest decompression, which matters if assignment packages grow to include datasets. The API is straightforward for our use case: iterate the extracted `Record<string, Uint8Array>`, write public files to disk, and pass `solution.R` directly to the prompt builder — never to `fs.writeFileSync`.

---

## Integration Sketch (Stage 3)

```typescript
// infrastructure/packages/assignment-package-loader.ts
import { unzipSync } from 'fflate'
import { decrypt } from '../crypto/aes-gcm'

export interface AssignmentPackage {
  starterFile: { name: string; content: Buffer }
  specPdf:     { name: string; content: Buffer }
  solution:    string   // kept as string, injected into prompt only
}

export function loadPackage(
  encryptedZip: Buffer,
  key: Buffer
): AssignmentPackage {
  const zipBytes  = decrypt(encryptedZip, key)           // AES-GCM, key from server token
  const files     = unzipSync(new Uint8Array(zipBytes))

  return {
    starterFile: { name: 'hw.R',      content: Buffer.from(files['starter.R']) },
    specPdf:     { name: 'spec.pdf',  content: Buffer.from(files['spec.pdf'])  },
    solution:    new TextDecoder().decode(files['solution.R']),
  }
}
```

The `solution` field is never passed to any file-write path. It is consumed only by the prompt builder inside `execute-ask-use-case.ts`.

---

## Open Questions

1. **Package format** — Should `solution.R` always be at a fixed path inside the zip, or should the path be declared in `currentAssignment.starterFile` / a manifest file?
2. **Key delivery** — The backend can return a `packageToken` alongside `currentAssignment` in `GET /api/account/current_context`. Should the token itself be the AES key, or a short-lived opaque token the CLI exchanges for the key in a second request?
3. **Package size budget** — If assignments include data files (`.csv`, `.rds`), the zip could be several MB. `fflate`'s async `unzip` should be preferred over `unzipSync` above ~5 MB to avoid blocking the event loop.
