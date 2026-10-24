/**
 * Type definitions for Rate Limit Fallback Plugin
 */
// ============================================================================
// Constants
// ============================================================================
/**
 * Default fallback models
 *
 * NOTE: This is intentionally empty to force users to explicitly configure
 * their fallback models. This prevents unintended model usage (e.g., gemini
 * when not wanted) and makes configuration errors obvious immediately.
 *
 * Users must create a config file in one of these locations:
 * - <worktree>/.opencode/rate-limit-fallback.json
 * - <directory>/.opencode/rate-limit-fallback.json
 * - <directory>/rate-limit-fallback.json
 * - ~/.opencode/rate-limit-fallback.json
 * - $XDG_CONFIG_HOME/opencode/rate-limit-fallback.json
 */
export const DEFAULT_FALLBACK_MODELS = [];
/**
 * Default retry policy
 */
export const DEFAULT_RETRY_POLICY = {
    maxRetries: 3,
    strategy: "immediate",
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitterEnabled: false,
    jitterFactor: 0.1,
    polynomialBase: 1.5,
    polynomialExponent: 2,
};
/**
 * Default circuit breaker configuration
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
    enabled: false,
    failureThreshold: 5,
    recoveryTimeoutMs: 60000,
    halfOpenMaxCalls: 1,
    successThreshold: 2,
};
/**
 * Valid fallback modes
 */
export const VALID_FALLBACK_MODES = ["cycle", "stop", "retry-last", "wait"];
/**
 * Valid otherModels options (OpenCode v2)
 */
export const VALID_OTHER_MODELS = ["ignore", "wait"];
/**
 * Valid headless on rate limit options
 */
export const VALID_HEADLESS_ON_RATE_LIMIT = ["ignore", "abort"];
/**
 * Valid retry strategies
 */
export const VALID_RETRY_STRATEGIES = ["immediate", "exponential", "linear", "polynomial", "custom"];
/**
 * Valid reset intervals
 */
export const VALID_RESET_INTERVALS = ["hourly", "daily", "weekly"];
/**
 * Reset interval values in milliseconds
 */
export const RESET_INTERVAL_MS = {
    hourly: 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
};
/**
 * Deduplication window for fallback processing
 */
export const DEDUP_WINDOW_MS = 5000;
/**
 * State timeout for retry state
 */
export const STATE_TIMEOUT_MS = 30000;
/**
 * Cleanup interval for stale entries
 */
export const CLEANUP_INTERVAL_MS = 300000; // 5 minutes
/**
 * TTL for session entries
 */
export const SESSION_ENTRY_TTL_MS = 3600000; // 1 hour
