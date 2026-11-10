// Port of codex-rs/memories/write/src/phase1_output.rs (V1 contract).
// DSH has no structured-output option, so the schema is enforced here (D4).

import { redactSecrets } from './redact.js'

const ALLOWED_FIELDS = new Set(['raw_memory', 'rollout_summary', 'rollout_slug'])

function stripCodeFence(source) {
  const trimmed = source.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/iu.exec(trimmed)
  return fenced === null ? trimmed : fenced[1]
}

/**
 * Parses and redacts one stage-one model response.
 * @throws when the response violates the output contract, which fails the job.
 */
export function parseStageOneOutput(source) {
  const parsed = JSON.parse(stripCodeFence(source))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('stage-one output is not a JSON object')
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.has(key)) throw new TypeError(`stage-one output has unknown field "${key}"`)
  }
  const { raw_memory: rawMemory, rollout_summary: rolloutSummary, rollout_slug: rolloutSlug } = parsed
  if (typeof rawMemory !== 'string') throw new TypeError('stage-one output raw_memory must be a string')
  if (typeof rolloutSummary !== 'string') throw new TypeError('stage-one output rollout_summary must be a string')
  if (rolloutSlug !== undefined && rolloutSlug !== null && typeof rolloutSlug !== 'string') {
    throw new TypeError('stage-one output rollout_slug must be a string or null')
  }
  return {
    rawMemory: redactSecrets(rawMemory),
    rolloutSummary: redactSecrets(rolloutSummary),
    rolloutSlug: typeof rolloutSlug === 'string' ? redactSecrets(rolloutSlug) : null,
  }
}
