// Port of codex-rs/memories/write/src/phase2.rs (V1): global consolidation.

import { STAGE_TWO } from './config.js'
import { pruneOldExtensionResources } from './extensions.js'
import { buildConsolidationPrompt } from './prompts.js'
import { rebuildRawMemoriesFile, removeMemorySymlinks, syncRolloutSummaries } from './storage.js'
import { tryAcquireWorkspaceLock } from './workspace-lock.js'
import {
  memoryWorkspaceDiff,
  prepareMemoryWorkspace,
  resetMemoryWorkspaceBaseline,
  validateConsolidationArtifacts,
  writeWorkspaceDiff,
} from './workspace.js'

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

async function isValid(root) {
  try {
    await validateConsolidationArtifacts(root)
    return true
  } catch {
    return false
  }
}

function completionWatermark(claimed, memories) {
  return memories.reduce((max, memory) => Math.max(max, memory.sourceUpdatedAt), claimed)
}

class Job {
  constructor(deps, claim) {
    this.deps = deps
    this.claim = claim
  }

  failed(reason, detail) {
    const { store, logger } = this.deps
    logger.warn(`phase 2 ${reason}${detail === undefined ? '' : `: ${detail}`}`)
    const { ownershipToken } = this.claim
    if (!store.markGlobalPhase2JobFailed(ownershipToken, reason, STAGE_TWO.jobRetryDelaySeconds)) {
      store.markGlobalPhase2JobFailedIfUnowned(ownershipToken, reason, STAGE_TWO.jobRetryDelaySeconds)
    }
    return { status: reason }
  }

  succeed(watermark, memories, status) {
    const done = this.deps.store.markGlobalPhase2JobSucceeded(this.claim.ownershipToken, watermark, memories)
    return { status: done ? status : 'failed_mark_succeeded', input: memories.length }
  }
}

/** Runs the agent while renewing the job lease; losing the lease aborts the agent. */
async function runAgentWithHeartbeat(deps, job, request) {
  const controller = new AbortController()
  const signal = request.signal === undefined ? controller.signal : AbortSignal.any([request.signal, controller.signal])
  let lost
  const timer = setInterval(() => {
    let owned = false
    try {
      owned = deps.store.heartbeatGlobalPhase2Job(job.claim.ownershipToken, STAGE_TWO.jobLeaseSeconds)
    } catch (error) {
      lost = `phase-2 heartbeat update failed: ${errorText(error)}`
      controller.abort(new Error(lost))
      return
    }
    if (!owned) {
      lost = 'lost global phase-2 ownership during heartbeat'
      controller.abort(new Error(lost))
    }
  }, deps.heartbeatMs ?? STAGE_TWO.jobHeartbeatSeconds * 1000)
  timer.unref?.()
  try {
    const result = await deps.runner.run({ ...request, signal })
    return lost === undefined ? result : { status: 'failed', error: lost }
  } catch (error) {
    return { status: 'failed', error: lost ?? errorText(error) }
  } finally {
    clearInterval(timer)
  }
}

async function consolidate(deps, job, memories, watermark, { currentThreadId, signal }) {
  const root = deps.config.memoryRoot
  const result = await runAgentWithHeartbeat(deps, job, {
    root,
    prompt: buildConsolidationPrompt(root),
    route: deps.config.consolidationModel,
    reasoningEffort: STAGE_TWO.reasoningEffort,
    currentThreadId,
    signal,
  })
  if (result.status !== 'completed') {
    await removeMemorySymlinks(root).catch(() => {})
    return job.failed('failed_agent', result.error)
  }
  try {
    await validateConsolidationArtifacts(root)
  } catch (error) {
    return job.failed('failed_invalid_artifacts', errorText(error))
  }
  // The baseline must not move if another worker has taken over the workspace.
  let stillOwned
  try {
    stillOwned = deps.store.heartbeatGlobalPhase2Job(job.claim.ownershipToken, STAGE_TWO.jobLeaseSeconds)
  } catch (error) {
    return job.failed('failed_confirm_ownership', errorText(error))
  }
  if (!stillOwned) {
    deps.logger.warn('phase 2 lost ownership before resetting the workspace baseline')
    return { status: 'lost_ownership' }
  }
  try {
    await resetMemoryWorkspaceBaseline(root)
  } catch (error) {
    return job.failed('failed_workspace_commit', errorText(error))
  }
  return job.succeed(watermark, memories, 'succeeded')
}

/**
 * Consolidates the current stage-one outputs into the memory root.
 * @param {object} deps `{config, store, runner, clock, logger, heartbeatMs?}`
 * @param {object} run `{currentThreadId, threads, signal}`
 * @returns {Promise<{status:string, input?:number}>}
 */
export async function runPhase2(deps, { currentThreadId, threads, signal }) {
  const root = deps.config.memoryRoot
  const lock = await tryAcquireWorkspaceLock(root, deps.clock)
  if (lock === null) return { status: 'skipped_workspace_busy' }
  try {
    const claim = deps.store.tryClaimGlobalPhase2Job({ workerId: currentThreadId, leaseSeconds: STAGE_TWO.jobLeaseSeconds })
    if (claim.outcome !== 'claimed') return { status: claim.outcome }
    const job = new Job(deps, claim)

    try {
      await prepareMemoryWorkspace(root)
    } catch (error) {
      return job.failed('failed_prepare_workspace', errorText(error))
    }

    const memories = deps.store.getPhase2InputSelection(
      deps.config.maxRawMemoriesForConsolidation,
      deps.config.maxUnusedDays,
      new Map(threads.map((thread) => [thread.id, thread])),
    )
    const watermark = completionWatermark(claim.inputWatermark, memories)

    try {
      await syncRolloutSummaries(root, memories)
      await rebuildRawMemoriesFile(root, memories)
      await pruneOldExtensionResources(root, deps.clock.nowMs())
    } catch (error) {
      return job.failed('failed_sync_workspace_inputs', errorText(error))
    }

    let diff
    try {
      diff = await memoryWorkspaceDiff(root)
    } catch (error) {
      return job.failed('failed_workspace_status', errorText(error))
    }
    if (diff.changes.length === 0 && (await isValid(root))) {
      return job.succeed(watermark, memories, 'succeeded_no_workspace_changes')
    }

    try {
      await writeWorkspaceDiff(root, diff)
    } catch (error) {
      return job.failed('failed_workspace_diff_file', errorText(error))
    }
    return await consolidate(deps, job, memories, watermark, { currentThreadId, signal })
  } finally {
    await lock.release()
  }
}
