// Port of codex-rs/state/src/runtime/memories.rs and state/memory_migrations.
// The `threads` table has no equivalent here: thread facts arrive from the
// adapter on each run and the same filters are applied in code (D3).

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const JOB_KIND_MEMORY_STAGE1 = 'memory_stage1'
const JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL = 'memory_consolidate_global'
const MEMORY_CONSOLIDATION_JOB_KEY = 'global'
const PHASE2_SUCCESS_COOLDOWN_SECONDS = 6 * 60 * 60
const DEFAULT_RETRY_REMAINING = 3
const SECONDS_PER_DAY = 86_400
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stage1_outputs (
    thread_id TEXT PRIMARY KEY,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
    selected_for_phase2_source_updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at
    ON stage1_outputs(source_updated_at DESC, thread_id DESC);
CREATE TABLE IF NOT EXISTS jobs (
    kind TEXT NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    ownership_token TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    lease_until INTEGER,
    retry_at INTEGER,
    retry_remaining INTEGER NOT NULL,
    last_error TEXT,
    input_watermark INTEGER,
    last_success_watermark INTEGER,
    PRIMARY KEY (kind, job_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_retry_lease
    ON jobs(kind, status, retry_at, lease_until);
`

const ENQUEUE_GLOBAL_CONSOLIDATION = `
INSERT INTO jobs (
    kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
    lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark
) VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, 0)
ON CONFLICT(kind, job_key) DO UPDATE SET
    status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'pending' END,
    retry_at = CASE WHEN jobs.status = 'running' THEN jobs.retry_at ELSE NULL END,
    retry_remaining = max(jobs.retry_remaining, excluded.retry_remaining),
    input_watermark = CASE
        WHEN excluded.input_watermark > COALESCE(jobs.input_watermark, 0)
            THEN excluded.input_watermark
        ELSE COALESCE(jobs.input_watermark, 0) + 1
    END
`

const CLAIM_STAGE1_JOB = `
INSERT INTO jobs (
    kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
    lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark
)
SELECT ?, ?, 'running', ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, NULL
WHERE (
    SELECT COUNT(*) FROM jobs
    WHERE kind = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until > ?
) < ?
ON CONFLICT(kind, job_key) DO UPDATE SET
    status = 'running',
    worker_id = excluded.worker_id,
    ownership_token = excluded.ownership_token,
    started_at = excluded.started_at,
    finished_at = NULL,
    lease_until = excluded.lease_until,
    retry_at = NULL,
    retry_remaining = CASE
        WHEN excluded.input_watermark > COALESCE(jobs.input_watermark, -1) THEN ?
        ELSE jobs.retry_remaining
    END,
    last_error = NULL,
    input_watermark = excluded.input_watermark
WHERE
    (jobs.status != 'running' OR jobs.lease_until IS NULL OR jobs.lease_until <= excluded.started_at)
    AND (
        jobs.retry_at IS NULL
        OR jobs.retry_at <= excluded.started_at
        OR excluded.input_watermark > COALESCE(jobs.input_watermark, -1)
    )
    AND (
        jobs.retry_remaining > 0
        OR excluded.input_watermark > COALESCE(jobs.input_watermark, -1)
    )
    AND (
        SELECT COUNT(*) FROM jobs AS running_jobs
        WHERE running_jobs.kind = excluded.kind
          AND running_jobs.status = 'running'
          AND running_jobs.lease_until IS NOT NULL
          AND running_jobs.lease_until > excluded.started_at
          AND running_jobs.job_key != excluded.job_key
    ) < ?
`

const MARK_STAGE1_DONE = `
UPDATE jobs SET
    status = 'done',
    finished_at = ?,
    lease_until = NULL,
    last_error = NULL,
    last_success_watermark = input_watermark
WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?
`

const UPSERT_STAGE1_OUTPUT = `
INSERT INTO stage1_outputs (
    thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    source_updated_at = excluded.source_updated_at,
    raw_memory = excluded.raw_memory,
    rollout_summary = excluded.rollout_summary,
    rollout_slug = excluded.rollout_slug,
    generated_at = excluded.generated_at
WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at
`

const SELECT_PHASE2_CANDIDATES = `
SELECT thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at
FROM stage1_outputs AS so
WHERE (length(trim(so.raw_memory)) > 0 OR length(trim(so.rollout_summary)) > 0)
  AND (
        (so.last_usage IS NOT NULL AND so.last_usage >= ?)
        OR (so.last_usage IS NULL AND so.source_updated_at >= ?)
  )
ORDER BY
    COALESCE(so.usage_count, 0) DESC,
    COALESCE(so.last_usage, so.source_updated_at) DESC,
    so.source_updated_at DESC,
    so.thread_id DESC
`

const PRUNE_STAGE1_OUTPUTS = `
DELETE FROM stage1_outputs
WHERE thread_id IN (
    SELECT thread_id FROM stage1_outputs
    WHERE selected_for_phase2 = 0
      AND COALESCE(last_usage, source_updated_at) < ?
    ORDER BY COALESCE(last_usage, source_updated_at) ASC, source_updated_at ASC, thread_id ASC
    LIMIT ?
)
`

/** Whole seconds, the resolution of every persisted timestamp. */
function toSeconds(ms) {
  return Math.floor(ms / 1000)
}

export class MemoryStore {
  #db
  #clock

  /**
   * @param {string} path
   * @param {import('./ports.js').Clock} clock
   */
  constructor(path, clock) {
    this.#clock = clock
    mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.#db.exec(SCHEMA)
  }

  close() {
    this.#db.close()
  }

  #nowSeconds() {
    return toSeconds(this.#clock.nowMs())
  }

  #transaction(body) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #run(sql, ...params) {
    return Number(this.#db.prepare(sql).run(...params).changes)
  }

  #get(sql, ...params) {
    return this.#db.prepare(sql).get(...params)
  }

  #enqueueGlobalConsolidation(inputWatermark) {
    this.#run(
      ENQUEUE_GLOBAL_CONSOLIDATION,
      JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
      MEMORY_CONSOLIDATION_JOB_KEY,
      DEFAULT_RETRY_REMAINING,
      inputWatermark,
    )
  }

  #isUpToDate(threadId, sourceUpdatedAt) {
    const output = this.#get('SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?', threadId)
    if (output !== undefined && output.source_updated_at >= sourceUpdatedAt) return true
    const job = this.#get(
      'SELECT last_success_watermark FROM jobs WHERE kind = ? AND job_key = ?',
      JOB_KIND_MEMORY_STAGE1,
      threadId,
    )
    return job?.last_success_watermark != null && job.last_success_watermark >= sourceUpdatedAt
  }

  /**
   * Attempts to claim the stage-one job of one thread at one source version.
   * @returns {{outcome:'claimed', ownershipToken:string}
   *   | {outcome:'up_to_date'|'running'|'retry_backoff'|'retry_exhausted'}}
   */
  tryClaimStage1Job({ threadId, workerId, sourceUpdatedAt, leaseSeconds, maxRunningJobs }) {
    const now = this.#nowSeconds()
    const ownershipToken = randomUUID()
    return this.#transaction(() => {
      if (this.#isUpToDate(threadId, sourceUpdatedAt)) return { outcome: 'up_to_date' }
      const claimed = this.#run(
        CLAIM_STAGE1_JOB,
        JOB_KIND_MEMORY_STAGE1,
        threadId,
        workerId,
        ownershipToken,
        now,
        now + Math.max(leaseSeconds, 0),
        DEFAULT_RETRY_REMAINING,
        sourceUpdatedAt,
        JOB_KIND_MEMORY_STAGE1,
        now,
        maxRunningJobs,
        DEFAULT_RETRY_REMAINING,
        maxRunningJobs,
      )
      if (claimed > 0) return { outcome: 'claimed', ownershipToken }
      const job = this.#get(
        'SELECT status, lease_until, retry_at, retry_remaining FROM jobs WHERE kind = ? AND job_key = ?',
        JOB_KIND_MEMORY_STAGE1,
        threadId,
      )
      if (job !== undefined) {
        if (job.retry_remaining <= 0) return { outcome: 'retry_exhausted' }
        if (job.retry_at !== null && job.retry_at > now) return { outcome: 'retry_backoff' }
      }
      return { outcome: 'running' }
    })
  }

  /**
   * Applies the startup claim rules to the adapter's thread list and claims a bounded batch.
   * @param {import('./ports.js').ThreadMeta[]} threads
   */
  claimStage1JobsForStartup(threads, params) {
    const { currentThreadId, scanLimit, maxClaimed, maxAgeDays, minRolloutIdleHours, leaseSeconds } = params
    if (scanLimit === 0 || maxClaimed === 0) return []
    const nowMs = this.#clock.nowMs()
    const maxAgeCutoff = nowMs - Math.max(maxAgeDays, 0) * MS_PER_DAY
    const idleCutoff = nowMs - Math.max(minRolloutIdleHours, 0) * MS_PER_HOUR
    const candidates = threads
      .filter(
        (thread) =>
          thread.memoryMode === 'enabled' &&
          thread.id !== currentThreadId &&
          thread.updatedAtMs >= maxAgeCutoff &&
          thread.updatedAtMs <= idleCutoff,
      )
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, scanLimit)

    const claimed = []
    for (const thread of candidates) {
      if (claimed.length >= maxClaimed) break
      const sourceUpdatedAt = toSeconds(thread.updatedAtMs)
      const claim = this.tryClaimStage1Job({
        threadId: thread.id,
        workerId: currentThreadId,
        sourceUpdatedAt,
        leaseSeconds,
        maxRunningJobs: maxClaimed,
      })
      if (claim.outcome === 'claimed') {
        claimed.push({ thread, sourceUpdatedAt, ownershipToken: claim.ownershipToken })
      }
    }
    return claimed
  }

  markStage1JobSucceeded({ threadId, ownershipToken, sourceUpdatedAt, rawMemory, rolloutSummary, rolloutSlug }) {
    const now = this.#nowSeconds()
    return this.#transaction(() => {
      const updated = this.#run(MARK_STAGE1_DONE, now, JOB_KIND_MEMORY_STAGE1, threadId, ownershipToken)
      if (updated === 0) return false
      this.#run(UPSERT_STAGE1_OUTPUT, threadId, sourceUpdatedAt, rawMemory, rolloutSummary, rolloutSlug, now)
      this.#enqueueGlobalConsolidation(sourceUpdatedAt)
      return true
    })
  }

  /** Completes a job that produced nothing worth keeping and forgets the thread's previous output. */
  markStage1JobSucceededNoOutput({ threadId, ownershipToken }) {
    const now = this.#nowSeconds()
    return this.#transaction(() => {
      const updated = this.#run(MARK_STAGE1_DONE, now, JOB_KIND_MEMORY_STAGE1, threadId, ownershipToken)
      if (updated === 0) return false
      const { input_watermark: sourceUpdatedAt } = this.#get(
        'SELECT input_watermark FROM jobs WHERE kind = ? AND job_key = ? AND ownership_token = ?',
        JOB_KIND_MEMORY_STAGE1,
        threadId,
        ownershipToken,
      )
      const deleted = this.#run('DELETE FROM stage1_outputs WHERE thread_id = ?', threadId)
      if (deleted > 0) this.#enqueueGlobalConsolidation(sourceUpdatedAt)
      return true
    })
  }

  markStage1JobFailed({ threadId, ownershipToken, failureReason, retryDelaySeconds }) {
    const now = this.#nowSeconds()
    const updated = this.#run(
      `UPDATE jobs SET
          status = 'error',
          finished_at = ?,
          lease_until = NULL,
          retry_at = ?,
          retry_remaining = retry_remaining - 1,
          last_error = ?
       WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?`,
      now,
      now + Math.max(retryDelaySeconds, 0),
      failureReason,
      JOB_KIND_MEMORY_STAGE1,
      threadId,
      ownershipToken,
    )
    return updated > 0
  }

  /** Gives a claim back without spending a retry: the route was unusable, the rollout is not at fault (D13). */
  releaseStage1Job({ threadId, ownershipToken, reason }) {
    const updated = this.#run(
      `UPDATE jobs SET
          status = 'pending',
          lease_until = NULL,
          ownership_token = NULL,
          last_error = ?
       WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?`,
      reason,
      JOB_KIND_MEMORY_STAGE1,
      threadId,
      ownershipToken,
    )
    return updated > 0
  }

  /**
   * Claims the single global consolidation job unless it is running, in retry
   * backoff, or inside the post-success cooldown.
   * @returns {{outcome:'claimed', ownershipToken:string, inputWatermark:number}
   *   | {outcome:'skipped_retry_unavailable'|'skipped_cooldown'|'skipped_running'}}
   */
  tryClaimGlobalPhase2Job({ workerId, leaseSeconds }) {
    const now = this.#nowSeconds()
    const leaseUntil = now + Math.max(leaseSeconds, 0)
    const cooldownCutoff = now - PHASE2_SUCCESS_COOLDOWN_SECONDS
    const ownershipToken = randomUUID()
    return this.#transaction(() => {
      const job = this.#get(
        `SELECT status, lease_until, retry_at, input_watermark, finished_at, last_error
         FROM jobs WHERE kind = ? AND job_key = ?`,
        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
        MEMORY_CONSOLIDATION_JOB_KEY,
      )
      if (job === undefined) {
        this.#run(
          `INSERT INTO jobs (
              kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
              lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark
           ) VALUES (?, ?, 'running', ?, ?, ?, NULL, ?, NULL, ?, NULL, 0, 0)`,
          JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
          MEMORY_CONSOLIDATION_JOB_KEY,
          workerId,
          ownershipToken,
          now,
          leaseUntil,
          DEFAULT_RETRY_REMAINING,
        )
        return { outcome: 'claimed', ownershipToken, inputWatermark: 0 }
      }
      if (job.retry_at !== null && job.retry_at > now) return { outcome: 'skipped_retry_unavailable' }
      if (job.status === 'running' && job.lease_until !== null && job.lease_until > now) return { outcome: 'skipped_running' }
      if (job.last_error === null && job.finished_at !== null && job.finished_at > cooldownCutoff) return { outcome: 'skipped_cooldown' }
      const claimed = this.#run(
        `UPDATE jobs SET
            status = 'running',
            worker_id = ?,
            ownership_token = ?,
            started_at = ?,
            finished_at = NULL,
            lease_until = ?,
            retry_at = NULL,
            last_error = NULL
         WHERE kind = ? AND job_key = ?
           AND (status != 'running' OR lease_until IS NULL OR lease_until <= ?)
           AND (retry_at IS NULL OR retry_at <= ?)
           AND (last_error IS NOT NULL OR finished_at IS NULL OR finished_at <= ?)`,
        workerId,
        ownershipToken,
        now,
        leaseUntil,
        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
        MEMORY_CONSOLIDATION_JOB_KEY,
        now,
        now,
        cooldownCutoff,
      )
      if (claimed === 0) return { outcome: 'skipped_running' }
      return { outcome: 'claimed', ownershipToken, inputWatermark: job.input_watermark ?? 0 }
    })
  }

  /** @returns {boolean} whether the caller still owns the running job */
  heartbeatGlobalPhase2Job(ownershipToken, leaseSeconds) {
    const updated = this.#run(
      `UPDATE jobs SET lease_until = ?
       WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?`,
      this.#nowSeconds() + Math.max(leaseSeconds, 0),
      JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
      MEMORY_CONSOLIDATION_JOB_KEY,
      ownershipToken,
    )
    return updated > 0
  }

  /** Records success and the exact snapshots this consolidation consumed. */
  markGlobalPhase2JobSucceeded(ownershipToken, completedWatermark, selectedOutputs) {
    const now = this.#nowSeconds()
    return this.#transaction(() => {
      const updated = this.#run(
        `UPDATE jobs SET
            status = 'done',
            finished_at = ?,
            lease_until = NULL,
            last_error = NULL,
            last_success_watermark = max(COALESCE(last_success_watermark, 0), ?)
         WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?`,
        now,
        completedWatermark,
        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
        MEMORY_CONSOLIDATION_JOB_KEY,
        ownershipToken,
      )
      if (updated === 0) return false
      this.#run(
        `UPDATE stage1_outputs SET selected_for_phase2 = 0, selected_for_phase2_source_updated_at = NULL
         WHERE selected_for_phase2 != 0 OR selected_for_phase2_source_updated_at IS NOT NULL`,
      )
      for (const output of selectedOutputs) {
        this.#run(
          `UPDATE stage1_outputs SET selected_for_phase2 = 1, selected_for_phase2_source_updated_at = ?
           WHERE thread_id = ? AND source_updated_at = ?`,
          output.sourceUpdatedAt,
          output.threadId,
          output.sourceUpdatedAt,
        )
      }
      return true
    })
  }

  #markGlobalPhase2JobFailed(ownerCondition, ownershipToken, failureReason, retryDelaySeconds) {
    const now = this.#nowSeconds()
    const updated = this.#run(
      `UPDATE jobs SET
          status = 'error',
          finished_at = ?,
          lease_until = NULL,
          retry_at = ?,
          retry_remaining = max(retry_remaining - 1, 0),
          last_error = ?
       WHERE kind = ? AND job_key = ? AND status = 'running' AND ${ownerCondition}`,
      now,
      now + Math.max(retryDelaySeconds, 0),
      failureReason,
      JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
      MEMORY_CONSOLIDATION_JOB_KEY,
      ownershipToken,
    )
    return updated > 0
  }

  markGlobalPhase2JobFailed(ownershipToken, failureReason, retryDelaySeconds) {
    return this.#markGlobalPhase2JobFailed('ownership_token = ?', ownershipToken, failureReason, retryDelaySeconds)
  }

  markGlobalPhase2JobFailedIfUnowned(ownershipToken, failureReason, retryDelaySeconds) {
    return this.#markGlobalPhase2JobFailed('(ownership_token = ? OR ownership_token IS NULL)', ownershipToken, failureReason, retryDelaySeconds)
  }

  /** Adds one use to each output and returns how many outputs existed. */
  recordStage1OutputUsage(threadIds) {
    if (threadIds.length === 0) return 0
    const now = this.#nowSeconds()
    return this.#transaction(() =>
      threadIds.reduce(
        (updated, threadId) =>
          updated +
          this.#run('UPDATE stage1_outputs SET usage_count = COALESCE(usage_count, 0) + 1, last_usage = ? WHERE thread_id = ?', now, threadId),
        0,
      ),
    )
  }

  clearMemoryData() {
    this.#transaction(() => {
      this.#run('DELETE FROM stage1_outputs')
      this.#run('DELETE FROM jobs WHERE kind IN (?, ?)', JOB_KIND_MEMORY_STAGE1, JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL)
    })
  }

  /** Aggregates for the status command. */
  status() {
    const count = (sql, ...params) => this.#get(sql, ...params).total
    const consolidation = this.#get(
      'SELECT status, finished_at, last_error FROM jobs WHERE kind = ? AND job_key = ?',
      JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
      MEMORY_CONSOLIDATION_JOB_KEY,
    )
    return {
      outputs: count('SELECT COUNT(*) AS total FROM stage1_outputs'),
      failedJobs: count(`SELECT COUNT(*) AS total FROM jobs WHERE kind = ? AND status = 'error'`, JOB_KIND_MEMORY_STAGE1),
      consolidation: consolidation === undefined
        ? null
        : { status: consolidation.status, finishedAt: consolidation.finished_at, lastError: consolidation.last_error },
    }
  }

  /** Deletes stale, never-consolidated outputs. */
  pruneStage1OutputsForRetention(maxUnusedDays, limit) {
    if (limit === 0) return 0
    const cutoff = this.#nowSeconds() - Math.max(maxUnusedDays, 0) * SECONDS_PER_DAY
    return this.#run(PRUNE_STAGE1_OUTPUTS, cutoff, limit)
  }

  /**
   * Returns the phase-two input set: top-N by usage then recency, in stable thread-id order.
   * Threads the harness no longer reports, or that are not enabled, are excluded.
   * @param {Map<string, import('./ports.js').ThreadMeta>} threadsById
   */
  getPhase2InputSelection(n, maxUnusedDays, threadsById) {
    if (n === 0) return []
    const cutoff = this.#nowSeconds() - Math.max(maxUnusedDays, 0) * SECONDS_PER_DAY
    const selected = []
    for (const row of this.#db.prepare(SELECT_PHASE2_CANDIDATES).iterate(cutoff, cutoff)) {
      const thread = threadsById.get(row.thread_id)
      if (thread === undefined || thread.memoryMode !== 'enabled') continue
      selected.push({
        threadId: row.thread_id,
        sourceUpdatedAt: row.source_updated_at,
        rawMemory: row.raw_memory,
        rolloutSummary: row.rollout_summary,
        rolloutSlug: row.rollout_slug,
        generatedAt: row.generated_at,
        cwd: thread.cwd,
        rolloutPath: thread.rolloutPath,
        gitBranch: thread.gitBranch,
        createdAtMs: thread.createdAtMs,
      })
      if (selected.length >= n) break
    }
    return selected.sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0))
  }
}
