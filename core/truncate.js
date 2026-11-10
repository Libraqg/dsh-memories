// Port of the token-budget head/tail truncation in codex-rs/utils/string/src/truncate.rs.
// Lengths are UTF-8 bytes, like Rust string lengths.

const APPROX_BYTES_PER_TOKEN = 4

export function approxBytesForTokens(tokens) {
  return tokens * APPROX_BYTES_PER_TOKEN
}

function approxTokensFromByteCount(bytes) {
  return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN)
}

function isContinuationByte(byte) {
  return (byte & 0xc0) === 0x80
}

function floorCharBoundary(buffer, index) {
  let at = Math.min(index, buffer.length)
  while (at > 0 && at < buffer.length && isContinuationByte(buffer[at])) at -= 1
  return at
}

function ceilCharBoundary(buffer, index) {
  let at = Math.min(index, buffer.length)
  while (at < buffer.length && isContinuationByte(buffer[at])) at += 1
  return at
}

/** Keeps the head and tail of `text` within a token budget; the marker is outside the budget. */
export function truncateTextToTokens(text, maxTokens) {
  const buffer = Buffer.from(text, 'utf8')
  const maxBytes = approxBytesForTokens(maxTokens)
  if (buffer.length <= maxBytes) return text
  const left = Math.floor(maxBytes / 2)
  const right = maxBytes - left
  const prefixEnd = floorCharBoundary(buffer, left)
  const suffixStart = ceilCharBoundary(buffer, buffer.length - right)
  const removedTokens = approxTokensFromByteCount(buffer.length - maxBytes)
  return (
    buffer.subarray(0, prefixEnd).toString('utf8') +
    `…${removedTokens} tokens truncated…` +
    buffer.subarray(suffixStart).toString('utf8')
  )
}
