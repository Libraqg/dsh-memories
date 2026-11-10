// Port of MemoriesConfig in codex-rs/config/src/types.rs and the limits in
// codex-rs/memories/write/src/lib.rs. Defaults and clamps match upstream.

import { join } from 'node:path'

/** Fixed tunables of the extraction phase, not user configuration upstream either. */
export const STAGE_ONE = Object.freeze({
  reasoningEffort: 'low',
  concurrencyLimit: 8,
  jobLeaseSeconds: 3_600,
  jobRetryDelaySeconds: 3_600,
  threadScanLimit: 5_000,
  pruneBatchSize: 200,
})

/** Fixed tunables of the consolidation phase. */
export const STAGE_TWO = Object.freeze({
  reasoningEffort: 'medium',
  jobLeaseSeconds: 3_600,
  jobRetryDelaySeconds: 3_600,
  jobHeartbeatSeconds: 90,
})

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function integerOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback
}

/**
 * @param {object} raw
 * @param {string} raw.memoryRoot Directory that holds the memory artifacts.
 * @param {string} [raw.stateDbPath] SQLite path; defaults beside the memory root.
 * @param {unknown} raw.extractModel Route handed to `ModelClient`, opaque to the core.
 * @param {unknown} [raw.consolidationModel] Same, for phase two.
 */
export function resolveMemoriesConfig(raw) {
  if (typeof raw?.memoryRoot !== 'string' || raw.memoryRoot.length === 0) {
    throw new TypeError('memoryRoot is required')
  }
  if (raw.extractModel === undefined || raw.extractModel === null) {
    throw new TypeError('extractModel is required')
  }
  return Object.freeze({
    memoryRoot: raw.memoryRoot,
    stateDbPath: raw.stateDbPath ?? join(raw.memoryRoot, '..', 'memories_state.sqlite'),
    generateMemories: raw.generateMemories ?? true,
    useMemories: raw.useMemories ?? true,
    extractModel: raw.extractModel,
    consolidationModel: raw.consolidationModel ?? raw.extractModel,
    maxRawMemoriesForConsolidation: clamp(integerOr(raw.maxRawMemoriesForConsolidation, 256), 1, 4096),
    maxUnusedDays: clamp(integerOr(raw.maxUnusedDays, 30), 0, 365),
    maxRolloutAgeDays: clamp(integerOr(raw.maxRolloutAgeDays, 10), 0, 90),
    maxRolloutsPerStartup: clamp(integerOr(raw.maxRolloutsPerStartup, 2), 1, 128),
    minRolloutIdleHours: clamp(integerOr(raw.minRolloutIdleHours, 6), 1, 48),
  })
}
