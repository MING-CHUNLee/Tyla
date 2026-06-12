/**
 * Application Constants
 *
 * Centralized constants for the CLI application.
 * Following 12-Factor App principle: configuration in one place.
 */

// ============================================
// Cache Configuration
// ============================================

export const CACHE = {
    /** Environment cache TTL (5 minutes) */
    ENVIRONMENT_TTL_MS: 5 * 60 * 1000,
    /** File scan cache TTL (30 seconds) */
    FILE_SCAN_TTL_MS: 30 * 1000,
} as const;

// ============================================
// Display Limits
// ============================================

export const DISPLAY = {
    /** Maximum files to show in scan result */
    MAX_FILES_DISPLAY: 10,
    /** Maximum packages to list in prompt */
    MAX_PACKAGES_TO_LIST: 50,
    /** Maximum files to list in prompt */
    MAX_FILES_TO_LIST: 20,
    /** Minimal mode package limit */
    MINIMAL_PACKAGES_LIMIT: 10,
    /** Minimal mode file limit */
    MINIMAL_FILES_LIMIT: 5,
} as const;

// ============================================
// LLM Configuration
// ============================================

export const LLM = {
    /** Default request timeout (90 seconds) */
    DEFAULT_TIMEOUT_MS: 90_000,
    /** Maximum timeout allowed (5 minutes) */
    MAX_TIMEOUT_MS: 5 * 60 * 1000,
    /** Default max tokens */
    DEFAULT_MAX_TOKENS: 8192,
    /** Maximum retry attempts */
    MAX_RETRIES: 3,
    /** Maximum backoff delay (10 seconds) */
    MAX_BACKOFF_MS: 10_000,
    /** System prompt max length */
    MAX_SYSTEM_PROMPT_LENGTH: 100_000,
    /** User message max length */
    MAX_USER_MESSAGE_LENGTH: 50_000,
} as const;

// ============================================
// File Scanning
// ============================================

export const FILE_SCAN = {
    /** Recursive glob pattern */
    RECURSIVE_PATTERN: '**/*',
    /** Top-level only pattern */
    TOP_LEVEL_PATTERN: '*',
    /** Hidden file patterns to ignore */
    HIDDEN_FILE_PATTERNS: ['**/.*', '**/.*/**'],
} as const;

// ============================================
// R Script Configuration
// ============================================

export const R_SCRIPT = {
    /** Temp script filename prefix */
    TEMP_SCRIPT_PREFIX: 'tyla_r_script_',
    /** Temp script file extension */
    TEMP_SCRIPT_EXTENSION: '.R',
} as const;

// ============================================
// Token Estimation
// ============================================

export const TOKEN_ESTIMATION = {
    /** Characters per token for English text */
    CHARS_PER_TOKEN_ENGLISH: 4,
    /** Characters per token for Chinese text */
    CHARS_PER_TOKEN_CHINESE: 2,
} as const;

// ============================================
// Supported Languages
// ============================================

export const SUPPORTED_LANGUAGES = ['en', 'zh-TW'] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

// ============================================
// R Code Execution (Plumber API)
// ============================================

export const EXECUTION = {
    /** Default Plumber API host */
    DEFAULT_HOST: 'localhost',
    /** Default Plumber API port */
    DEFAULT_PORT: 8787,
    /** Default execution timeout (30 seconds) */
    DEFAULT_TIMEOUT_MS: 30_000,
    /** Maximum execution timeout (10 minutes) */
    MAX_TIMEOUT_MS: 10 * 60 * 1000,
    /** Polling interval for async results (500ms) */
    POLL_INTERVAL_MS: 500,
    /** Maximum polling attempts */
    MAX_POLL_ATTEMPTS: 120,
    /** Connection retry attempts */
    CONNECTION_RETRIES: 3,
    /** Connection retry delay (1 second) */
    CONNECTION_RETRY_DELAY_MS: 1000,
} as const;

// ============================================
// Package Installation
// ============================================

export const INSTALLATION = {
    /** Default CRAN repository */
    DEFAULT_REPOS: 'https://cran.rstudio.com',
    /** Default installation timeout (5 minutes) */
    DEFAULT_TIMEOUT_MS: 5 * 60 * 1000,
    /** Maximum installation timeout (30 minutes) */
    MAX_TIMEOUT_MS: 30 * 60 * 1000,
    /** Package check timeout (10 seconds) */
    CHECK_TIMEOUT_MS: 10_000,
} as const;

// ============================================
// Ruby Backend API
// ============================================

export const RUBY_API = {
    HOST: process.env.API_HOST ?? 'localhost',
    PORT: Number(process.env.API_PORT ?? 9090),
    /** Default request timeout (60 seconds — LLM calls can be slow) */
    DEFAULT_TIMEOUT_MS: 60_000,
} as const;

// ============================================
// Tyla API (guard checks, analytics)
// ============================================

export const TYLA_API = {
    HOST: process.env.TYLA_API_HOST ?? 'localhost',
    PORT: Number(process.env.TYLA_API_PORT ?? 9292),
    /** Default request timeout (60 seconds — LLM judge calls can be slow) */
    DEFAULT_TIMEOUT_MS: 60_000,
    /**
     * Tutor chat timeout. The backend may make two LLM calls per request
     * (hybrid lazy solution loading, plan 2026-06-11 §3), each bounded by its
     * 30s READ_TIMEOUT — so this must exceed 60s plus assembly/network overhead.
     */
    TUTOR_TIMEOUT_MS: 90_000,
} as const;

// ============================================
// Package Safety
// ============================================

export const SAFETY = {
    /** Maximum days since last update before warning */
    MAX_DAYS_SINCE_UPDATE: 730, // 2 years
    /** Maximum number of dependencies before warning */
    MAX_DEPENDENCIES: 50,
    /** Minimum monthly downloads to be considered trusted */
    MIN_MONTHLY_DOWNLOADS: 100,
    /** Metadata fetch timeout */
    METADATA_FETCH_TIMEOUT_MS: 10_000,
    /** Stats fetch timeout */
    STATS_FETCH_TIMEOUT_MS: 5_000,
    /** Enable safety checks by default */
    ENABLE_SAFETY_CHECKS: true,
} as const;
