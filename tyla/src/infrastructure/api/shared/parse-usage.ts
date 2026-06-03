/**
 * Shared token-usage parser for tyla-api gateways (guard_checks, tutor_chats).
 *
 * The wire shape (`{ input_tokens, output_tokens }`) is identical across endpoints, so
 * both gateways validate it the same way: non-negative integers within a sane bound,
 * anything else falls back to 0.
 */

export interface Usage {
    inputTokens: number;
    outputTokens: number;
}

export function parseUsage(
    raw: { input_tokens: number; output_tokens: number } | null | undefined,
): Usage {
    const MAX = 1_000_000;
    const safe = (n: unknown): number =>
        typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX ? n : 0;
    return { inputTokens: safe(raw?.input_tokens), outputTokens: safe(raw?.output_tokens) };
}
