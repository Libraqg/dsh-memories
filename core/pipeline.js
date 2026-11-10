// Port of codex-rs/memories/write/src/start.rs.

import { STAGE_ONE } from './config.js'
import { seedExtensionInstructions } from './extensions.js'
import { runPhase1 } from './phase1.js'
import { runPhase2 } from './phase2.js'
import { silentLogger, systemClock } from './ports.js'
import { ensureLayout } from './storage.js'

/**
 * Runs one background pass: prune, extract, consolidate.
 * @param {object} deps `{config, store, source, model, runner, clock?, logger?, heartbeatMs?}`
 * @param {object} run `{currentThreadId, signal?}`
 */
export async function runMemoryPipeline(deps, { currentThreadId, signal }) {
  const context = { logger: silentLogger, clock: systemClock, ...deps }
  const { config, store, source, model, logger } = context
  if (!config.generateMemories) return { status: 'disabled' }

  await ensureLayout(config.memoryRoot)
  await seedExtensionInstructions(config.memoryRoot)
  // Pruning costs no tokens, so it happens before the route checks.
  store.pruneStage1OutputsForRetention(config.maxUnusedDays, STAGE_ONE.pruneBatchSize)

  // Checked before claiming so that a missing route never consumes job retries (D13).
  const extraction = await model.available(config.extractModel, signal)
  if (!extraction.ok) {
    logger.warn(`memory pipeline skipped: extraction route unavailable: ${extraction.reason}`)
    return { status: 'skipped_route_unavailable', reason: extraction.reason }
  }

  const threads = await source.listThreads(signal)
  const phase1 = await runPhase1(context, { currentThreadId, threads, signal })

  const consolidation = await model.available(config.consolidationModel, signal)
  if (!consolidation.ok) {
    logger.warn(`memory consolidation skipped: route unavailable: ${consolidation.reason}`)
    return { status: 'completed', phase1, phase2: { status: 'skipped_route_unavailable', reason: consolidation.reason } }
  }
  const phase2 = await runPhase2(context, { currentThreadId, threads, signal })
  logger.info(`memory phase 2: ${phase2.status}`)
  return { status: 'completed', phase1, phase2 }
}
