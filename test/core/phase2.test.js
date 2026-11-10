import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { CURRENT_THREAD, EXTRACT_ROUTE, WORKSPACE_DIFF, memoryJson, pipelineHarness, thread, writeValidArtifacts } from '../helpers/fakes.js'

const CONSOLIDATION_ROUTE = { provider: 'test-sub', model: 'strong' }

const exists = (path) => stat(path).then(() => true, () => false)
const rootOf = ({ deps }) => deps.config.memoryRoot

function setup(options = {}) {
  return pipelineHarness({ ...options, overrides: { consolidationModel: CONSOLIDATION_ROUTE, ...options.overrides } })
}

test('the first consolidation builds the artifacts and resets the baseline', async () => {
  const harness = await setup()
  const result = await harness.run()
  assert.deepEqual(result.phase2, { status: 'succeeded', input: 1 })
  const root = rootOf(harness)
  assert.equal(await exists(join(root, 'MEMORY.md')), true)
  assert.equal((await readFile(join(root, 'memory_summary.md'), 'utf8')).split('\n')[0], 'v1')
  assert.equal(await exists(join(root, '.git')), true)
  assert.equal(await exists(join(root, WORKSPACE_DIFF)), false, 'the prompt artifact is removed')
  assert.equal(await exists(`${root}.lock`), false, 'the workspace lock is released')

  const [request] = harness.deps.runner.requests
  assert.deepEqual(request.route, CONSOLIDATION_ROUTE)
  assert.equal(request.reasoningEffort, 'medium')
  assert.equal(request.currentThreadId, CURRENT_THREAD)
  assert.ok(request.prompt.includes(root))
  assert.ok(request.prompt.includes(WORKSPACE_DIFF))
  assert.ok(request.prompt.includes('Memory extensions (under'), 'the seeded extension is advertised')
  assert.equal(request.prompt.includes('{{'), false)
  assert.ok(request.diff.includes('- A raw_memories.md'))
  assert.ok(request.diff.includes('- A extensions/ad_hoc/instructions.md'))
  assert.match(request.diff, /- A rollout_summaries\/.*\.md/)
})

test('nothing changed means no model call', async () => {
  const harness = await setup()
  await harness.run()
  const again = await harness.runAfterCooldown()
  assert.equal(again.phase2.status, 'succeeded_no_workspace_changes')
  assert.equal(harness.deps.runner.requests.length, 1)
})

test('the cooldown blocks a second consolidation for six hours', async () => {
  const source = thread('a')
  const harness = await setup({ threads: [source] })
  await harness.run()
  source.updatedAtMs += 60_000
  assert.equal((await harness.run()).phase2.status, 'skipped_cooldown')
  assert.equal(harness.deps.runner.requests.length, 1)
})

test('an incremental run sees only what changed', async () => {
  const source = thread('a')
  const other = thread('b')
  const harness = await setup({ threads: [source, other], respond: (r) => memoryJson(r.input.includes('test://a') ? 'a' : 'b', { raw_memory: `gen ${r.input.includes('test://a') ? harness.gen : 1}` }) })
  harness.gen = 1
  await harness.run()
  harness.gen = 2
  source.updatedAtMs += 60_000
  await harness.runAfterCooldown()
  const [, second] = harness.deps.runner.requests
  assert.ok(second.diff.includes('- M raw_memories.md'))
  assert.ok(second.diff.includes('+gen 2'))
  assert.ok(second.diff.includes('-gen 1'))
  assert.equal(second.diff.includes('A MEMORY.md'), false)
  assert.equal((second.diff.match(/^- [AMD] rollout_summaries/gm) ?? []).length, 1)
})

test('a thread that disappears is offered to the agent as a deletion', async () => {
  const threads = [thread('a')]
  const harness = await setup({ threads })
  await harness.run()
  threads.length = 0
  const again = await harness.runAfterCooldown()
  assert.equal(again.phase2.status, 'succeeded')
  const [, second] = harness.deps.runner.requests
  assert.match(second.diff, /- D rollout_summaries\/.*\.md/)
  assert.deepEqual(await readdir(join(rootOf(harness), 'rollout_summaries')), [])
})

test('a manual edit to a memory file reaches the agent', async () => {
  const harness = await setup()
  await harness.run()
  await writeFile(join(rootOf(harness), 'MEMORY.md'), '# Task Group: test\nUser correction: always use tabs.\n')
  await harness.runAfterCooldown()
  const [, second] = harness.deps.runner.requests
  assert.ok(second.diff.includes('- M MEMORY.md'))
  assert.ok(second.diff.includes('+User correction: always use tabs.'))
})

test('invalid artifacts fail the job, keep the baseline and back off', async () => {
  const harness = await setup({
    runnerAct: async ({ root }) => {
      await writeFile(join(root, 'MEMORY.md'), 'x')
      await writeFile(join(root, 'memory_summary.md'), 'not v1\n')
    },
  })
  assert.equal((await harness.run()).phase2.status, 'failed_invalid_artifacts')
  assert.equal((await harness.run()).phase2.status, 'skipped_retry_unavailable')

  harness.deps.runner.act = writeValidArtifacts
  harness.clock.advanceHours(2)
  assert.equal((await harness.run()).phase2.status, 'succeeded', 'a failure does not start the success cooldown')
  const [, retry] = harness.deps.runner.requests
  assert.ok(retry.diff.includes('A raw_memories.md'), 'the baseline did not advance')
})

test('a failed agent keeps the baseline', async () => {
  const harness = await setup({ runnerAct: async () => ({ status: 'failed', error: 'model exploded' }) })
  assert.equal((await harness.run()).phase2.status, 'failed_agent')
  harness.deps.runner.act = writeValidArtifacts
  harness.clock.advanceHours(2)
  await harness.run()
  assert.ok(harness.deps.runner.requests[1].diff.includes('A raw_memories.md'))
})

test('a thrown runner error is contained as a job failure', async () => {
  const harness = await setup({ runnerAct: async () => { throw new Error('spawn failed') } })
  assert.equal((await harness.run()).phase2.status, 'failed_agent')
  assert.equal(await exists(`${rootOf(harness)}.lock`), false)
})

test('a symlink left by the agent fails validation and is removed', async () => {
  const harness = await setup({
    runnerAct: async (request) => {
      await writeValidArtifacts(request)
      await symlink('/etc/hosts', join(request.root, 'escape.md'))
    },
  })
  assert.equal((await harness.run()).phase2.status, 'failed_invalid_artifacts')
  assert.equal((await readdir(rootOf(harness))).includes('escape.md'), false)
})

test('losing the lease aborts the agent and never resets the baseline', async () => {
  const harness = await setup({
    deps: { heartbeatMs: 5 },
    runnerAct: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'failed', error: 'aborted' }), { once: true })),
  })
  harness.deps.store.heartbeatGlobalPhase2Job = () => false
  assert.equal((await harness.run()).phase2.status, 'failed_agent')
})

test('ownership lost at the very end leaves the baseline alone', async () => {
  const harness = await setup()
  harness.deps.store.heartbeatGlobalPhase2Job = () => false
  assert.equal((await harness.run()).phase2.status, 'lost_ownership')
})

test('a held workspace lock skips the run without claiming it', async () => {
  const harness = await setup()
  const lock = `${rootOf(harness)}.lock`
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: harness.clock.nowMs() }))
  assert.equal((await harness.run()).phase2.status, 'skipped_workspace_busy')
  assert.equal(harness.deps.runner.requests.length, 0)
  await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 1, at: harness.clock.nowMs() }))
  assert.equal((await harness.run()).phase2.status, 'succeeded', 'a dead owner does not block forever')
})

test('an unavailable consolidation route skips phase two but keeps extraction', async () => {
  const harness = await setup()
  harness.deps.model.available = async (route) => (route.provider === EXTRACT_ROUTE.provider ? { ok: true } : { ok: false, reason: 'signed out' })
  const result = await harness.run()
  assert.equal(result.phase1.succeeded, 1)
  assert.deepEqual(result.phase2, { status: 'skipped_route_unavailable', reason: 'signed out' })
  assert.equal(harness.deps.runner.requests.length, 0)
})

test('consumed outputs survive retention', async () => {
  const harness = await setup()
  await harness.run()
  harness.clock.advanceHours(40 * 24)
  assert.equal(harness.deps.store.pruneStage1OutputsForRetention(30, 200), 0)
})

test('extension resources past retention are offered as deletions, seeds are not overwritten', async () => {
  const harness = await setup()
  const root = rootOf(harness)
  const resources = join(root, 'extensions/ad_hoc/resources')
  await mkdir(resources, { recursive: true })
  await writeFile(join(resources, '2026-11-01T00-00-00-note.md'), 'note')
  await harness.run()
  const instructions = join(root, 'extensions/ad_hoc/instructions.md')
  await writeFile(instructions, 'edited by the user')
  harness.clock.advanceHours(8 * 24)
  await harness.run()
  assert.equal(await readFile(instructions, 'utf8'), 'edited by the user')
  assert.deepEqual(await readdir(resources), [])
  assert.ok(harness.deps.runner.requests[1].diff.includes('- D extensions/ad_hoc/resources/2026-11-01T00-00-00-note.md'))
})
