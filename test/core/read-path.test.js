import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { AD_HOC_NOTE_TOOL, buildMemoryReadInstructions } from '../../core/read-path.js'
import { ensureLayout } from '../../core/storage.js'
import { tempMemoryRoot } from '../helpers/fakes.js'

async function root(summary) {
  const { memoryRoot } = await tempMemoryRoot()
  await ensureLayout(memoryRoot)
  if (summary !== undefined) await writeFile(join(memoryRoot, 'memory_summary.md'), summary)
  return memoryRoot
}

test('nothing is injected until a summary exists', async () => {
  assert.equal(await buildMemoryReadInstructions(await root()), undefined)
  assert.equal(await buildMemoryReadInstructions(await root('   \n')), undefined)
})

test('the instructions embed the summary and the memory root', async () => {
  const memoryRoot = await root('v1\n## User Profile\nlikes polars\n')
  const text = await buildMemoryReadInstructions(memoryRoot)
  assert.ok(text.includes('========= MEMORY_SUMMARY BEGINS =========\nv1\n## User Profile\nlikes polars\n========= MEMORY_SUMMARY ENDS ========='))
  assert.ok(text.includes(`${memoryRoot}/MEMORY.md`))
  assert.equal(text.includes('{{'), false)
})

test('a long summary is truncated to 2500 tokens, keeping both ends', async () => {
  const text = await buildMemoryReadInstructions(await root(`HEAD${'x'.repeat(40_000)}TAIL`))
  assert.ok(text.includes('HEAD'))
  assert.ok(text.includes('TAIL'))
  assert.ok(text.includes('tokens truncated'))
  const embedded = text.split('MEMORY_SUMMARY BEGINS =========\n')[1].split('\n========= MEMORY_SUMMARY ENDS')[0]
  assert.ok(embedded.length < 10_100, `2500 tokens is about 10 KB, got ${embedded.length}`)
})

test('the upstream template carries only the documented edits', async () => {
  const text = await buildMemoryReadInstructions(await root('v1\n'))
  assert.equal(text.includes('oai-mem-citation'), false, 'D7: citation markup cannot be hidden')
  assert.equal(text.includes('rollout_path'), false, 'D8: compressed logs cannot be searched')
  assert.equal(text.includes('append-only `jsonl`'), false)
  assert.ok(text.includes(`\`${AD_HOC_NOTE_TOOL}\``), 'D14: notes go through the tool')
  assert.match(text, /3\. Only if MEMORY\.md directly points[\s\S]*\n4\. If there are no relevant hits/)
  assert.equal(/\n5\. If there are no relevant hits/.test(text), false)
  assert.ok(text.includes('Decision boundary: should you use memory'))
  assert.ok(text.includes('Updating memories:'))
  assert.ok(text.includes('How to decide whether to verify memory:'))
})
