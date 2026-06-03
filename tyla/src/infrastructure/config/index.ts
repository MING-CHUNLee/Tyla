/**
 * Configuration Manager
 * 
 * Centralized configuration management using environment variables.
 * 
 * Best Practices References:
 * - LangChain: Uses standard env variable names (OPENAI_API_KEY, ANTHROPIC_API_KEY)
 * - Vercel AI SDK: Uses dotenv for local dev, env vars for production
 * - 12-Factor App: Config stored in environment, not code
 * 
 * Usage:
 *   const config = getConfig();
 *   const llmConfig = getLLMConfigFromEnv();
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load .env file if it exists
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
}

// ============================================
// Types
// ============================================

export type LLMProvider = 'openai' | 'anthropic' | 'azure' | 'ollama' | 'google';

export interface LLMConfig {
    provider: LLMProvider;
    apiKey: string;
    model: string;
    endpoint?: string;
    timeout: number;
    maxTokens: number;
}

export interface AppConfig {
    /** LLM provider configuration */
    llm: LLMConfig;
    /** Debug mode */
    debug: boolean;
    /** Log level */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================
// Environment Variable Names (following LangChain conventions)
// ============================================

export const ENV_VARS = {
    // Provider selection
    LLM_PROVIDER: 'LLM_PROVIDER',

    // API Keys (LangChain-compatible naming)
    OPENAI_API_KEY: 'OPENAI_API_KEY',
    ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
    AZURE_OPENAI_API_KEY: 'AZURE_OPENAI_API_KEY',
    GEMINI_API_KEY: 'GEMINI_API_KEY',

    // Model configuration
    LLM_MODEL: 'LLM_MODEL',
    LLM_MAX_TOKENS: 'LLM_MAX_TOKENS',
    LLM_TIMEOUT: 'LLM_TIMEOUT',

    // Custom endpoints
    OPENAI_API_BASE: 'OPENAI_API_BASE',
    AZURE_OPENAI_ENDPOINT: 'AZURE_OPENAI_ENDPOINT',
    OLLAMA_HOST: 'OLLAMA_HOST',

    // App settings
    DEBUG: 'DEBUG',
    LOG_LEVEL: 'LOG_LEVEL',

    // Option B guard pre-call gate — '1' / 'true' enables the guard_checks pre-call.
    GUARD_PRECALL: 'TYLA_GUARD_PRECALL',
} as const;

// ============================================
// Default Values
// ============================================

const DEFAULTS = {
    provider: 'openai' as LLMProvider,
    timeout: 30000,
    maxTokens: 4096,
    logLevel: 'info' as const,
    models: {
        openai: 'gpt-4o',
        anthropic: 'claude-3-5-sonnet-20241022',
        azure: 'gpt-4o',
        ollama: 'llama3.2',
        google: 'gemini-2.0-flash',
    },
    endpoints: {
        openai: 'https://api.openai.com/v1/chat/completions',
        anthropic: 'https://api.anthropic.com/v1/messages',
        ollama: 'http://localhost:11434/api/chat',
        google: 'https://generativelanguage.googleapis.com/v1beta/models',
    },
};

// ============================================
// Configuration Functions
// ============================================

/**
 * Get environment variable with optional default
 */
export function getEnv(key: string, defaultValue?: string): string | undefined {
    return process.env[key] ?? defaultValue;
}

/**
 * Get required environment variable (throws if missing)
 */
export function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(
            `No API key found for "${key}".\n` +
            `Please add it to the .env file in your project root directory and restart tyla.\n` +
            `Example: echo '${key}=your-api-key-here' >> .env`
        );
    }
    return value;
}

/**
 * Detect LLM provider from available API keys
 */
export function detectProvider(): LLMProvider {
    // Check explicit provider setting first
    const explicit = getEnv(ENV_VARS.LLM_PROVIDER);
    if (explicit && isValidProvider(explicit)) {
        return explicit as LLMProvider;
    }

    // Auto-detect from available API keys (LangChain pattern)
    if (getEnv(ENV_VARS.OPENAI_API_KEY)) return 'openai';
    if (getEnv(ENV_VARS.ANTHROPIC_API_KEY)) return 'anthropic';
    if (getEnv(ENV_VARS.AZURE_OPENAI_API_KEY)) return 'azure';
    if (getEnv(ENV_VARS.GEMINI_API_KEY)) return 'google';
    if (getEnv(ENV_VARS.OLLAMA_HOST)) return 'ollama';

    // Default to OpenAI
    return 'openai';
}

/**
 * Get API key for a specific provider
 */
export function getApiKeyForProvider(provider: LLMProvider): string {
    switch (provider) {
        case 'openai':
            return requireEnv(ENV_VARS.OPENAI_API_KEY);
        case 'anthropic':
            return requireEnv(ENV_VARS.ANTHROPIC_API_KEY);
        case 'azure':
            return requireEnv(ENV_VARS.AZURE_OPENAI_API_KEY);
        case 'google':
            return requireEnv(ENV_VARS.GEMINI_API_KEY);
        case 'ollama':
            return ''; // Ollama doesn't require API key
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

/**
 * Get endpoint for a provider
 */
export function getEndpointForProvider(provider: LLMProvider): string {
    switch (provider) {
        case 'openai':
            return getEnv(ENV_VARS.OPENAI_API_BASE) || DEFAULTS.endpoints.openai;
        case 'anthropic':
            return DEFAULTS.endpoints.anthropic;
        case 'azure':
            return requireEnv(ENV_VARS.AZURE_OPENAI_ENDPOINT);
        case 'google':
            return DEFAULTS.endpoints.google;
        case 'ollama':
            return getEnv(ENV_VARS.OLLAMA_HOST) || DEFAULTS.endpoints.ollama;
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

/**
 * Get LLM configuration from environment variables
 */
export function getLLMConfigFromEnv(): LLMConfig {
    const provider = detectProvider();

    return {
        provider,
        apiKey: getApiKeyForProvider(provider),
        model: getEnv(ENV_VARS.LLM_MODEL) || DEFAULTS.models[provider],
        endpoint: getEndpointForProvider(provider),
        timeout: parseInt(getEnv(ENV_VARS.LLM_TIMEOUT) || String(DEFAULTS.timeout), 10),
        maxTokens: parseInt(getEnv(ENV_VARS.LLM_MAX_TOKENS) || String(DEFAULTS.maxTokens), 10),
    };
}

/**
 * Get full application configuration
 */
export function getConfig(): AppConfig {
    return {
        llm: getLLMConfigFromEnv(),
        debug: getEnv(ENV_VARS.DEBUG) === 'true',
        logLevel: (getEnv(ENV_VARS.LOG_LEVEL) || DEFAULTS.logLevel) as AppConfig['logLevel'],
    };
}

/**
 * Validate that required configuration is present
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
        const provider = detectProvider();

        // Check API key (except for Ollama)
        if (provider !== 'ollama') {
            try {
                getApiKeyForProvider(provider);
            } catch (e) {
                errors.push((e as Error).message);
            }
        }

        // Check Azure endpoint if using Azure
        if (provider === 'azure' && !getEnv(ENV_VARS.AZURE_OPENAI_ENDPOINT)) {
            errors.push(`Missing ${ENV_VARS.AZURE_OPENAI_ENDPOINT} for Azure provider`);
        }
    } catch (e) {
        errors.push((e as Error).message);
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Print configuration status (for debugging, hides sensitive data)
 */
export function getConfigSummary(): Record<string, string> {
    const provider = detectProvider();
    const hasApiKey = provider === 'ollama' || !!getEnv(getApiKeyEnvVar(provider));

    return {
        provider,
        model: getEnv(ENV_VARS.LLM_MODEL) || DEFAULTS.models[provider],
        apiKeyConfigured: hasApiKey ? '✓ Set' : '✗ Missing',
        endpoint: getEndpointForProvider(provider),
        maxTokens: getEnv(ENV_VARS.LLM_MAX_TOKENS) || String(DEFAULTS.maxTokens),
        timeout: getEnv(ENV_VARS.LLM_TIMEOUT) || String(DEFAULTS.timeout),
    };
}

// ============================================
// Helper Functions
// ============================================

function isValidProvider(value: string): value is LLMProvider {
    return ['openai', 'anthropic', 'azure', 'ollama', 'google'].includes(value);
}

function getApiKeyEnvVar(provider: LLMProvider): string {
    switch (provider) {
        case 'openai': return ENV_VARS.OPENAI_API_KEY;
        case 'anthropic': return ENV_VARS.ANTHROPIC_API_KEY;
        case 'azure': return ENV_VARS.AZURE_OPENAI_API_KEY;
        case 'google': return ENV_VARS.GEMINI_API_KEY;
        default: return '';
    }
}
