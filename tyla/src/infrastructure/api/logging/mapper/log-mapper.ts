/**
 * LogMapper
 *
 * Pure static mapping functions that translate between domain types and
 * backend wire formats. No side effects, no state, no HTTP.
 *
 * Domain types (what callers use) are also defined here so that both
 * gateways and clients import from a single source, avoiding circular deps.
 */

import type { SessionLogWire } from '../gateway/session-log-gateway';

// ============================================
// Domain Types  (caller-facing language)
// ============================================

export interface LogPayload {
    sessionId: string;
    prompt: string;
    response: string;
    responseTimeMs?: number;
    provider?: string;
    model?: string;
    type?: 'resolve' | 'edit' | 'chat';
}

// ============================================
// Mapper
// ============================================

export class LogMapper {
    /**
     * Domain LogPayload → SessionLogGateway wire format.
     * Stamps the current timestamp.
     */
    static toSessionLogWire(payload: LogPayload): SessionLogWire {
        return {
            sessionId: payload.sessionId,
            prompt: payload.prompt,
            response: payload.response,
            responseTimeMs: payload.responseTimeMs,
            provider: payload.provider,
            model: payload.model,
            type: payload.type,
            timestamp: new Date().toISOString(),
        };
    }
}
