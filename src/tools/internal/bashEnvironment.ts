/**
 * @fileoverview Shell process environment sanitization and filtering.
 * @packageDocumentation
 */

/**
 * Sensitive environment variable name patterns that must never leak into shell executions.
 */
const SENSITIVE_ENV_PATTERN =
  /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|HERNEX_HOME|GREG_)/i;

/**
 * Standard host environment variables safe to forward to child shell processes.
 */
const SAFE_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "NODE_PATH",
  "NODE_ENV",
]);

/**
 * Constructs a sanitized environment dictionary for shell command execution.
 *
 * Filters out all host API keys, authentication tokens, and secrets by default,
 * while forwarding standard execution variables (PATH, HOME, USER, etc.).
 *
 * @param extraAllowlist - Optional list of additional environment variable names to forward.
 * @returns Clean environment record safe for subprocess execution.
 *
 * @example
 * ```typescript
 * const env = getSafeBashEnvironment(["CUSTOM_VAR"]);
 * ```
 */
export function getSafeBashEnvironment(
  extraAllowlist?: readonly string[],
): Record<string, string> {
  const safeEnv: Record<string, string> = {
    TERM: "dumb",
  };

  const allowedSet = new Set<string>(extraAllowlist ?? []);

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }

    if (allowedSet.has(key)) {
      safeEnv[key] = value;
      continue;
    }

    if (SAFE_ENV_VARS.has(key) && !SENSITIVE_ENV_PATTERN.test(key)) {
      safeEnv[key] = value;
    }
  }

  return safeEnv;
}
