// Port of the V1 path through codex-rs/memories/write/src/rollout_input.rs and
// phase1.rs::serialize_filtered_rollout_response_items.

import { redactSecrets } from './redact.js'

const MAX_ROLLOUT_BYTES = 8 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024

function matchesMarkedFragment(text, startMarker, endMarker) {
  const trimmed = text.trim()
  return (
    trimmed.slice(0, startMarker.length).toLowerCase() === startMarker.toLowerCase() &&
    trimmed.slice(-endMarker.length).toLowerCase() === endMarker.toLowerCase()
  )
}

function isExcludedContextualUserFragment(item) {
  if (item.type !== 'input_text') return false
  return (
    matchesMarkedFragment(item.text, '# AGENTS.md instructions', '</INSTRUCTIONS>') ||
    matchesMarkedFragment(item.text, '<skill>', '</skill>')
  )
}

/** Applies the memory persistence policy to one item; returns undefined when it must not be used. */
export function sanitizeRolloutItem(item) {
  if (item.type !== 'message') return item
  if (item.role === 'developer' || item.role === 'system') return undefined
  if (item.role !== 'user') return item
  const content = item.content.filter((part) => !isExcludedContextualUserFragment(part))
  return content.length === 0 ? undefined : { ...item, content }
}

/**
 * Keeps the newest sanitized evidence that fits the byte budget, in source order.
 * Oversized records are skipped; older evidence beyond the budget is dropped.
 */
export function selectRecentRolloutItems(items) {
  let remaining = MAX_ROLLOUT_BYTES
  const selected = []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const sanitized = sanitizeRolloutItem(items[index])
    if (sanitized === undefined) continue
    const size = Buffer.byteLength(JSON.stringify(sanitized), 'utf8')
    if (size > MAX_RECORD_BYTES) continue
    if (size > remaining) break
    remaining -= size
    selected.push(sanitized)
  }
  return selected.reverse()
}

/** Serializes selected items for the stage-one prompt, redacting secrets before upload. */
export function serializeRolloutItems(items) {
  return redactSecrets(JSON.stringify(items))
}
