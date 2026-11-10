// Port of codex-rs/memories/write/src/phase1.rs (V1): per-thread extraction.

import { STAGE_ONE } from './config.js'
import { parseStageOneOutput } from './phase1-output.js'
import { ModelRouteUnavailableError } from './ports.js'
import { STAGE_ONE_SYSTEM_PROMPT, buildStageOneInputMessage } from './prompts.js'
import { selectRecentRolloutItems, serializeRolloutItems } from './rollout-input.js'

async function runBounded(items, limit, worker) {
  const results = []
  let next = 0
  async function drain() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain))
  return results
}

async function sample(deps, thread, contextWindow, signal) {
  const items = await deps.source.readRollout(thread.id, signal)
  const input = buildStageOneInputMessage({
    contextWindow,
    rolloutPath: thread.rolloutPath,
    rolloutCwd: thread.cwd,
    rolloutContents: serializeRolloutItems(selectRecentRolloutItems(items)),
  })
  const { text } = await deps.model.complete({
    route: deps.config.extractModel,
    system: STAGE_ONE_SYSTEM_PROMPT,
    input,
    reasoningEffort: STAGE_ONE.reasoningEffort,
    signal,
  })
  return parseStageOneOutput(text)
}

async function runJob(deps, claim, contextWindow, signal) {
  const { thread, sourceUpdatedAt, ownershipToken } = claim
  let output
  try {
    output = await sample(deps, thread, contextWindow, signal)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // Neither a broken route nor a host shutdown says anything about this rollout.
    if (error instanceof ModelRouteUnavailableError || signal?.aborted) {
      deps.logger.warn(`phase 1 released ${thread.id}: ${reason}`)
      deps.store.releaseStage1Job({ threadId: thread.id, ownershipToken, reason })
      return 'released'
    }
    deps.logger.warn(`phase 1 job failed for ${thread.id}: ${reason}`)
    deps.store.markStage1JobFailed({
      threadId: thread.id,
      ownershipToken,
      failureReason: reason,
      retryDelaySeconds: STAGE_ONE.jobRetryDelaySeconds,
    })
    return 'failed'
  }

  if (output.rawMemory.length === 0 || output.rolloutSummary.length === 0) {
    const done = deps.store.markStage1JobSucceededNoOutput({ threadId: thread.id, ownershipToken })
    return done ? 'succeeded_no_output' : 'failed'
  }
  const done = deps.store.markStage1JobSucceeded({
    threadId: thread.id,
    ownershipToken,
    sourceUpdatedAt,
    rawMemory: output.rawMemory,
    rolloutSummary: output.rolloutSummary,
    rolloutSlug: output.rolloutSlug,
  })
  return done ? 'succeeded' : 'failed'
}

/**
 * Claims eligible threads and extracts one stage-one output from each.
 * @param {object} deps `{config, store, source, model, logger}`
 * @param {object} run `{currentThreadId, threads, signal}`
 * @returns {Promise<{claimed:number, succeeded:number, succeeded_no_output:number, failed:number, released:number}>}
 */
export async function runPhase1(deps, { currentThreadId, threads, signal }) {
  const stats = { claimed: 0, succeeded: 0, succeeded_no_output: 0, failed: 0, released: 0 }
  const claims = deps.store.claimStage1JobsForStartup(threads, {
    currentThreadId,
    scanLimit: STAGE_ONE.threadScanLimit,
    maxClaimed: deps.config.maxRolloutsPerStartup,
    maxAgeDays: deps.config.maxRolloutAgeDays,
    minRolloutIdleHours: deps.config.minRolloutIdleHours,
    leaseSeconds: STAGE_ONE.jobLeaseSeconds,
  })
  stats.claimed = claims.length
  if (claims.length === 0) return stats

  const contextWindow = await deps.model.contextWindow(deps.config.extractModel, signal)
  const outcomes = await runBounded(claims, STAGE_ONE.concurrencyLimit, (claim) =>
    runJob(deps, claim, contextWindow, signal),
  )
  for (const outcome of outcomes) stats[outcome] += 1
  deps.logger.info(
    `memory stage-1 extraction complete: ${stats.claimed} claimed, ${stats.succeeded} with output, ` +
      `${stats.succeeded_no_output} no output, ${stats.failed} failed, ${stats.released} released`,
  )
  return stats
}
