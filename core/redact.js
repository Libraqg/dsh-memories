// Port of codex-rs/secrets/src/sanitizer.rs. Best effort, order matters.

const OPENAI_KEY = /sk-[A-Za-z0-9]{20,}/g
const AWS_ACCESS_KEY_ID = /\bAKIA[0-9A-Z]{16}\b/g
const BEARER_TOKEN = /\b[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+[A-Za-z0-9._~+/-]{16,}=*/g
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}/gi

/** Replaces well-known credential shapes with `[REDACTED_SECRET]`. */
export function redactSecrets(input) {
  return input
    .replace(BEARER_TOKEN, 'Bearer [REDACTED_SECRET]')
    .replace(OPENAI_KEY, '[REDACTED_SECRET]')
    .replace(AWS_ACCESS_KEY_ID, '[REDACTED_SECRET]')
    .replace(SECRET_ASSIGNMENT, '$1$2$3[REDACTED_SECRET]')
}
