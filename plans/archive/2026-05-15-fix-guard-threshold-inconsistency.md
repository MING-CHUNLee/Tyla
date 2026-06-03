# Fix: Guard Attack Threshold Inconsistency

**Date:** 2026-05-15

## Problem

`GUARD_ATTACK_THRESHOLD` is defined as `0.65` in `domain/types/guard-agent.ts`, but the Judge system prompt hardcodes `0.70` as the threshold it tells the LLM:

```
A message with attack ≥ 0.70 will be refused.
```

This means the LLM calibrates its scores against a wrong threshold — it believes 0.67 is safe, but the runtime will actually block it. The prompt and the code are out of sync.

## Root Cause

`buildJudgeSystemPrompt` in `application/prompts/guard-agent.ts` hardcodes `0.70` instead of importing and using `GUARD_ATTACK_THRESHOLD`.

## Fix

**File: `tyla/src/application/prompts/guard-agent.ts`**

Pass `threshold` as a parameter with the constant as default:

```ts
import { GUARD_ATTACK_THRESHOLD } from '../../domain/types/guard-agent';

export function buildJudgeSystemPrompt(
    policyText: string,
    threshold: number = GUARD_ATTACK_THRESHOLD,
): string {
    return `...
A message with attack ≥ ${threshold} will be refused.
...`;
}
```

**File: `tyla/src/application/services/guard-agent.ts`**

No change needed — `buildJudgeSystemPrompt` is already called with `policyText` only, so the default will apply automatically.

## Result

- Single source of truth: threshold lives only in `domain/types/guard-agent.ts`
- LLM calibrates its scores against the actual enforcement threshold
- Changing the constant automatically updates both the runtime check and the prompt
