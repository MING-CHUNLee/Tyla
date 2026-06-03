/**
 * Shared request preamble for tyla-api gateways (guard_checks, tutor_chats).
 *
 * Both endpoints live on the same server and authenticate identically: the student's
 * profile identifies the caller, and the LLM key/provider/endpoint/model travel in
 * X-LLM-* headers. This resolves all of that once so each gateway only has to supply
 * the path, the body, and its own response handling.
 */

import { getEnv, detectProvider, getApiKeyForProvider, getEndpointForProvider, ENV_VARS } from '../../config';
import { getProfile, UserProfile } from '../../config/profile';

export interface TylaApiRequest {
    /** Resolved student profile — caller spreads its ids into the request body. */
    profile: UserProfile;
    /** Content-Type plus the X-LLM-* auth headers. */
    headers: Record<string, string>;
}

/**
 * Resolve the student profile and LLM auth headers for a tyla-api call.
 *
 * @param label      prefix for thrown errors, e.g. 'guard-api' / 'tutor-api'.
 * @param directory  optional base dir for profile lookup (test / CWD override).
 * @throws if the profile is missing or no LLM key can be resolved.
 */
export function buildTylaApiRequest(label: string, directory?: string): TylaApiRequest {
    const profile = getProfile(directory);
    if (!profile) {
        throw new Error(`${label}: profile.json missing`);
    }

    const provider = detectProvider();
    let apiKey: string;
    try {
        apiKey = getApiKeyForProvider(provider);
    } catch {
        throw new Error(`${label}: could not resolve LLM key`);
    }

    return {
        profile,
        headers: {
            'Content-Type':   'application/json',
            'X-LLM-Key':      apiKey,
            'X-LLM-Provider': provider,
            'X-LLM-Endpoint': getEndpointForProvider(provider),
            'X-LLM-Model':    getEnv(ENV_VARS.LLM_MODEL) ?? '',
        },
    };
}
