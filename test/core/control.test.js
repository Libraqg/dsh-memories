import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { clearMemories, recordRolloutSummaryRead } from '../../core/control.js'
import { FIXTURE_NOW_MS, memoryJson, pipelineHarness, thread } from '../helpers/fakes.js'

const DAY_HOURS = 24

test('reading a summary credits its thread and changes the selection order', async () => {
  const older = thread('older', { updatedAtMs: FIXTURE_NOW_MS - 3 * DAY_HOURS * 3_600_000 })
  const newer = thread('newer')
  const harness = await pipelineHarness({
    threads: [older, newer],
    respond: (request) => memoryJson(request.input.includes('test://older') ? 'older' : 'newer'),
    overrides: { maxRawMemoriesForConsolidation: 1 },
  })
  await harness.run()
  const selected = () => harness.deps.store.getPhase2InputSelection(1, 30, new Map([[older.id, older], [newer.id, newer]])).map((row) => row.threadId)
  assert.deepEqual(selected(), [newer.id], 'recency wins before any use')

  // The first run kept only the newer thread on disk; write the older one's header as phase 2 would.
  const relative = 'rollout_summaries/older.md'
  await writeFile(join(harness.deps.config.memoryRoot, relative), `thread_id: ${older.id}\nupdated_at: x\n\nbody\n`)
  assert.equal(await recordRolloutSummaryRead(harness.deps, relative), true)
  assert.deepEqual(selected(), [older.id], 'a used memory outranks a newer unused one')
})

test('only rollout summaries are credited', async () => {
  const harness = await pipelineHarness()
  await harness.run()
  assert.equal(await recordRolloutSummaryRead(harness.deps, 'MEMORY.md'), false)
  assert.equal(await recordRolloutSummaryRead(harness.deps, 'rollout_summaries/missing.md'), false)
})

test('reset removes files and state, and yields to a running consolidation', async () => {
  const harness = await pipelineHarness()
  await harness.run()
  const root = harness.deps.config.memoryRoot
  const lock = `${root}.lock`
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: harness.clock.nowMs() }))
  assert.equal(await clearMemories(harness.deps), false)
  assert.ok((await readdir(root)).includes('MEMORY.md'))

  const { rm } = await import('node:fs/promises')
  await rm(lock)
  assert.equal(await clearMemories(harness.deps), true)
  assert.deepEqual(await readdir(root), [])
  assert.deepEqual(harness.deps.store.status(), { outputs: 0, failedJobs: 0, consolidation: null })

  const again = await harness.run()
  assert.equal(again.phase1.claimed, 1, 'a reset thread can be learned again')
})
