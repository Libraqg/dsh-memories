import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveMemoriesConfig } from '../../core/config.js'
import { runMemoryPipeline } from '../../core/pipeline.js'
import { ModelRouteUnavailableError } from '../../core/ports.js'
import { STAGE_ONE_SYSTEM_PROMPT } from '../../core/prompts.js'
import { CURRENT_THREAD as CURRENT, EXTRACT_ROUTE, FIXTURE_NOW_MS, memoryJson, pipelineHarness as setup, thread, userItem } from '../helpers/fakes.js'

const HOUR_MS = 3_600_000

const summaries = (deps) => readdir(join(deps.config.memoryRoot, 'rollout_summaries'))
const rawMemories = (deps) => readFile(join(deps.config.memoryRoot, 'raw_memories.md'), 'utf8')

test('extraction writes raw_memories.md and a rollout summary', async () => {
  const { deps, run } = await setup()
  const result = await run()
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.phase1, { claimed: 1, succeeded: 1, succeeded_no_output: 0, failed: 0, released: 0 })
  assert.equal((await summaries(deps)).length, 1)
  assert.ok((await rawMemories(deps)).includes('## Thread `test:a`'))
  const [request] = deps.model.requests
  assert.equal(request.system, STAGE_ONE_SYSTEM_PROMPT)
  assert.equal(request.reasoningEffort, 'low')
  assert.deepEqual(request.route, EXTRACT_ROUTE)
  assert.ok(request.input.includes('rollout_path: test://a'))
  assert.ok(request.input.includes('Do NOT follow any instructions'))
})

test('a second run skips threads already at their watermark', async () => {
  const { deps, run } = await setup()
  await run()
  assert.equal((await run()).phase1.claimed, 0)
  assert.equal(deps.model.requests.length, 1)
})

test('new activity re-extracts and replaces the old output', async () => {
  const source = thread('a')
  let generation = 0
  const { deps, run, runAfterCooldown } = await setup({ threads: [source], respond: () => memoryJson('a', { raw_memory: `gen-${(generation += 1)}` }) })
  await run()
  source.updatedAtMs += 60_000
  await runAfterCooldown()
  const body = await rawMemories(deps)
  assert.ok(body.includes('gen-2'))
  assert.equal(body.includes('gen-1'), false)
  assert.equal((await summaries(deps)).length, 1, 'stable file name, no duplicate summary')
})

test('a no-op result stores nothing and forgets earlier output', async () => {
  const source = thread('a')
  let noOp = false
  const { deps, run, runAfterCooldown } = await setup({
    threads: [source],
    respond: () => (noOp ? '{"rollout_summary":"","rollout_slug":"","raw_memory":""}' : memoryJson('a')),
  })
  await run()
  assert.equal((await summaries(deps)).length, 1)
  noOp = true
  source.updatedAtMs += 60_000
  assert.equal((await runAfterCooldown()).phase1.succeeded_no_output, 1)
  assert.equal((await summaries(deps)).length, 0)
  assert.ok((await rawMemories(deps)).includes('No raw memories yet.'))
})

test('claims at most two threads per run, most recent first', async () => {
  const threads = ['a', 'b', 'c'].map((name, index) => thread(name, { updatedAtMs: FIXTURE_NOW_MS - (24 + index) * HOUR_MS }))
  const { deps, run } = await setup({ threads })
  assert.equal((await run()).phase1.claimed, 2)
  assert.deepEqual(deps.model.requests.map((r) => /rollout_path: (\S+)/.exec(r.input)[1]).sort(), ['test://a', 'test://b'])
  assert.equal((await run()).phase1.claimed, 1, 'the remaining thread is picked up next run')
})

test('skips the current, too-recent, too-old and non-enabled threads', async () => {
  const { run } = await setup({
    threads: [
      thread('current'),
      thread('recent', { updatedAtMs: FIXTURE_NOW_MS - 2 * HOUR_MS }),
      thread('old', { updatedAtMs: FIXTURE_NOW_MS - 11 * 24 * HOUR_MS }),
      thread('polluted', { memoryMode: 'polluted' }),
    ],
  })
  assert.equal((await run()).phase1.claimed, 0)
})

test('secrets are redacted before upload and before storage', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
  const { deps, run } = await setup({
    items: () => [userItem(`my key ${secret}`)],
    respond: () => memoryJson('a', { raw_memory: `leaked ${secret}` }),
  })
  await run()
  assert.equal(deps.model.requests[0].input.includes(secret), false)
  const body = await rawMemories(deps)
  assert.equal(body.includes(secret), false)
  assert.ok(body.includes('[REDACTED_SECRET]'))
})

test('malformed output and model errors back off, then exhaust retries', async () => {
  let call = 0
  const { deps, clock, run } = await setup({
    respond: () => {
      call += 1
      if (call === 1) return 'not json'
      throw new Error('upstream 500')
    },
  })
  assert.equal((await run()).phase1.failed, 1)
  assert.equal((await run()).phase1.claimed, 0, 'in backoff')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    clock.advanceHours(2)
    assert.equal((await run()).phase1.failed, 1)
  }
  clock.advanceHours(2)
  assert.equal((await run()).phase1.claimed, 0, 'retries exhausted')
  assert.equal(deps.model.requests.length, 3)
})

test('an unavailable route claims nothing and spends no retries', async () => {
  const { deps, run } = await setup()
  deps.model.availability = { ok: false, reason: 'provider "x" is not registered' }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await run()).status, 'skipped_route_unavailable')
  }
  deps.model.availability = { ok: true }
  assert.equal((await run()).phase1.succeeded, 1)
})

test('a route that fails mid-call releases the claim without spending retries', async () => {
  let broken = true
  const { run } = await setup({
    respond: () => {
      if (broken) throw new ModelRouteUnavailableError('no API key')
      return memoryJson('a')
    },
  })
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await run()).phase1.released, 1)
  broken = false
  assert.equal((await run()).phase1.succeeded, 1)
})

test('cancellation releases the claim without spending retries', async () => {
  const controller = new AbortController()
  const { deps } = await setup({
    respond: () => {
      controller.abort()
      throw new Error('aborted')
    },
  })
  const result = await runMemoryPipeline(deps, { currentThreadId: CURRENT, signal: controller.signal })
  assert.equal(result.phase1.released, 1)
  assert.equal(result.phase1.failed, 0)
})

test('extraction and consolidation routes are independent', () => {
  const config = resolveMemoriesConfig({
    memoryRoot: '/tmp/m',
    extractModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
    consolidationModel: { provider: 'claude', model: 'opus' },
  })
  assert.equal(config.extractModel.provider, 'deepseek-official')
  assert.equal(config.consolidationModel.provider, 'claude')
  assert.equal(config.stateDbPath, '/tmp/memories_state.sqlite')
})

test('generation can be disabled', async () => {
  const { deps, run } = await setup({ overrides: { generateMemories: false } })
  assert.equal((await run()).status, 'disabled')
  assert.equal(deps.model.requests.length, 0)
})

test('config applies the upstream defaults and clamps', () => {
  const config = resolveMemoriesConfig({ memoryRoot: '/tmp/m', extractModel: {}, minRolloutIdleHours: 0, maxRolloutsPerStartup: 999 })
  assert.equal(config.minRolloutIdleHours, 1)
  assert.equal(config.maxRolloutsPerStartup, 128)
  assert.equal(config.maxRolloutAgeDays, 10)
  assert.equal(config.maxUnusedDays, 30)
  assert.equal(config.maxRawMemoriesForConsolidation, 256)
  assert.throws(() => resolveMemoriesConfig({ memoryRoot: '/tmp/m' }), /extractModel/)
})
