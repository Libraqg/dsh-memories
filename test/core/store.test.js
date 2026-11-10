import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MemoryStore } from '../../core/store.js'
import { FIXTURE_NOW_MS, fakeClock, tempMemoryRoot, thread } from '../helpers/fakes.js'

async function openStore() {
  const clock = fakeClock()
  const { stateDbPath } = await tempMemoryRoot()
  const store = new MemoryStore(stateDbPath, clock)
  return { store, clock }
}

const claimArgs = { threadId: 'test:a', workerId: 'w', sourceUpdatedAt: 100, leaseSeconds: 3600, maxRunningJobs: 2 }
const failure = { threadId: 'test:a', failureReason: 'boom', retryDelaySeconds: 3600 }

test('a claimed job blocks a second claim until its lease expires', async () => {
  const { store, clock } = await openStore()
  assert.equal(store.tryClaimStage1Job(claimArgs).outcome, 'claimed')
  assert.equal(store.tryClaimStage1Job(claimArgs).outcome, 'running')
  clock.advanceHours(2)
  assert.equal(store.tryClaimStage1Job(claimArgs).outcome, 'claimed')
})

test('running jobs are capped', async () => {
  const { store } = await openStore()
  assert.equal(store.tryClaimStage1Job({ ...claimArgs, threadId: 'test:a' }).outcome, 'claimed')
  assert.equal(store.tryClaimStage1Job({ ...claimArgs, threadId: 'test:b' }).outcome, 'claimed')
  assert.equal(store.tryClaimStage1Job({ ...claimArgs, threadId: 'test:c' }).outcome, 'running')
})

test('a succeeded version is up to date; a newer version is claimable', async () => {
  const { store } = await openStore()
  const { ownershipToken } = store.tryClaimStage1Job(claimArgs)
  store.markStage1JobSucceeded({ threadId: 'test:a', ownershipToken, sourceUpdatedAt: 100, rawMemory: 'r', rolloutSummary: 's', rolloutSlug: null })
  assert.equal(store.tryClaimStage1Job(claimArgs).outcome, 'up_to_date')
  assert.equal(store.tryClaimStage1Job({ ...claimArgs, sourceUpdatedAt: 101 }).outcome, 'claimed')
})

test('failures back off, exhaust after three attempts, and a newer version resets them', async () => {
  const { store, clock } = await openStore()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { outcome, ownershipToken } = store.tryClaimStage1Job(claimArgs)
    assert.equal(outcome, 'claimed')
    assert.equal(store.markStage1JobFailed({ ...failure, ownershipToken }), true)
    if (attempt < 2) assert.equal(store.tryClaimStage1Job(claimArgs).outcome, 'retry_backoff')
    clock.advanceHours(2)
  }
  assert.equal(store.tryClaimStage1Job(claimArgs).outcome, 'retry_exhausted')
  assert.equal(store.tryClaimStage1Job({ ...claimArgs, sourceUpdatedAt: 200 }).outcome, 'claimed')
})

test('a stale ownership token cannot finish a job', async () => {
  const { store } = await openStore()
  store.tryClaimStage1Job(claimArgs)
  assert.equal(store.markStage1JobFailed({ ...failure, ownershipToken: 'stale' }), false)
})

test('releasing a claim spends no retry and leaves the job claimable', async () => {
  const { store } = await openStore()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { outcome, ownershipToken } = store.tryClaimStage1Job(claimArgs)
    assert.equal(outcome, 'claimed')
    assert.equal(store.releaseStage1Job({ threadId: 'test:a', ownershipToken, reason: 'no key' }), true)
  }
})

test('releasing a claim neither refills nor spends earlier failures', async () => {
  const { store, clock } = await openStore()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { ownershipToken } = store.tryClaimStage1Job(claimArgs)
    store.markStage1JobFailed({ ...failure, ownershipToken })
    clock.advanceHours(2)
  }
  store.releaseStage1Job({ threadId: 'test:a', ownershipToken: store.tryClaimStage1Job(claimArgs).ownershipToken, reason: 'no key' })
  const { ownershipToken } = store.tryClaimStage1Job(claimArgs)
  store.markStage1JobFailed({ ...failure, ownershipToken })
  clock.advanceHours(2)
  assert.equal(store.tryClaimStage1Job(claimArgs).outcome, 'retry_exhausted')
})

function succeed(store, name, sourceUpdatedAt) {
  const threadId = `test:${name}`
  const { ownershipToken } = store.tryClaimStage1Job({ ...claimArgs, threadId, sourceUpdatedAt, maxRunningJobs: 100 })
  store.markStage1JobSucceeded({ threadId, ownershipToken, sourceUpdatedAt, rawMemory: `r-${name}`, rolloutSummary: 's', rolloutSlug: null })
}

const nowSeconds = Math.floor(FIXTURE_NOW_MS / 1000)
const DAY = 86_400

test('no-output success forgets the previous memory', async () => {
  const { store } = await openStore()
  succeed(store, 'a', nowSeconds)
  const map = new Map([['test:a', thread('a')]])
  assert.equal(store.getPhase2InputSelection(10, 30, map).length, 1)
  const { ownershipToken } = store.tryClaimStage1Job({ ...claimArgs, sourceUpdatedAt: nowSeconds + 1 })
  assert.equal(store.markStage1JobSucceededNoOutput({ threadId: 'test:a', ownershipToken }), true)
  assert.equal(store.getPhase2InputSelection(10, 30, map).length, 0)
})

test('phase-two selection drops stale and unknown threads, returns thread-id order', async () => {
  const { store } = await openStore()
  succeed(store, 'c', nowSeconds - DAY)
  succeed(store, 'a', nowSeconds - 2 * DAY)
  succeed(store, 'old', nowSeconds - 40 * DAY)
  succeed(store, 'gone', nowSeconds)
  const map = new Map(['a', 'c', 'old'].map((name) => [`test:${name}`, thread(name)]))
  assert.deepEqual(store.getPhase2InputSelection(10, 30, map).map((row) => row.threadId), ['test:a', 'test:c'])
  assert.deepEqual(store.getPhase2InputSelection(1, 30, map).map((row) => row.threadId), ['test:c'])
})

test('retention prunes only stale outputs', async () => {
  const { store } = await openStore()
  succeed(store, 'fresh', nowSeconds)
  succeed(store, 'old', nowSeconds - 40 * DAY)
  assert.equal(store.pruneStage1OutputsForRetention(30, 200), 1)
})
