import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDshSessionSource } from '../../../adapters/dsh/session-source.js'
import { fixtureSessionQuery } from '../../helpers/fakes.js'

async function source() {
  const sessionQuery = await fixtureSessionQuery()
  return { sessionQuery, dsh: createDshSessionSource({ sessionQuery }) }
}

test('lists root sessions that have user content, with namespaced ids', async () => {
  const { dsh } = await source()
  const ids = (await dsh.listThreads()).map((thread) => thread.id).sort()
  assert.deepEqual(ids, ['dsh:session-alpha', 'dsh:session-beta', 'dsh:session-fork'])
})

test('update time ignores bookkeeping and inherited events', async () => {
  const { dsh } = await source()
  const threads = new Map((await dsh.listThreads()).map((thread) => [thread.id, thread]))
  const alpha = threads.get('dsh:session-alpha')
  assert.equal(alpha.updatedAtMs, 1794045603000, 'the later session/title event does not count')
  assert.equal(alpha.createdAtMs, 1793959200000)
  assert.equal(alpha.rolloutPath, 'dsh://session/session-alpha')
  assert.equal(alpha.cwd, '/tmp/project-alpha')
  assert.equal(threads.get('dsh:session-fork').updatedAtMs, 1794040000000)
})

test('maps conversation events to rollout items and removes harness content', async () => {
  const { dsh } = await source()
  const items = await dsh.readRollout('dsh:session-alpha')
  assert.deepEqual(items.map((item) => [item.type, item.role]), [
    ['message', 'user'],
    ['message', 'user'],
    ['message', 'assistant'],
    ['function_call', undefined],
    ['function_call_output', undefined],
    ['message', 'assistant'],
  ])
  assert.deepEqual(items[3], { type: 'function_call', name: 'bash', arguments: '{"command":"npm test"}', call_id: 'call-1' })
  assert.deepEqual(items[4], { type: 'function_call_output', call_id: 'call-1', output: { body: 'upload.test.js timed out\n[image omitted]', success: false } })
  const text = JSON.stringify(items)
  assert.equal(text.includes('PRIVATE REASONING'), false)
  assert.equal(text.includes('Always use tabs'), false)
  assert.equal(text.includes('PRUNED STUB'), false, 'compaction replacements are not evidence')
  assert.ok(text.includes('Current time'), 'environment-style context stays, as upstream keeps it')
})

test('forks only contribute their own events', async () => {
  const { dsh } = await source()
  const text = JSON.stringify(await dsh.readRollout('dsh:session-fork'))
  assert.equal(text.includes('INHERITED'), false)
  assert.ok(text.includes('Own message'))
})

test('thread summaries are cached until the session is marked dirty', async () => {
  const { dsh, sessionQuery } = await source()
  await dsh.listThreads()
  const firstScan = sessionQuery.reads
  await dsh.listThreads()
  assert.equal(sessionQuery.reads, firstScan)
  dsh.markDirty('session-alpha')
  await dsh.listThreads()
  assert.equal(sessionQuery.reads, firstScan + 1)
})
