import assert from 'node:assert/strict'
import { readFile, readdir, symlink, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { ensureLayout, rebuildRawMemoriesFile, rolloutSummaryFileStem, syncRolloutSummaries } from '../../core/storage.js'
import { makeTempDir, tempMemoryRoot } from '../helpers/fakes.js'

const memory = (overrides = {}) => ({
  threadId: 'dsh:session-alpha',
  sourceUpdatedAt: 1794045603,
  rawMemory: '  raw body  ',
  rolloutSummary: '# summary',
  rolloutSlug: 'Fix Upload Test!',
  cwd: '/tmp/a',
  rolloutPath: 'dsh://session/session-alpha',
  gitBranch: null,
  createdAtMs: Date.UTC(2026, 10, 5, 1, 2, 3),
  ...overrides,
})

test('file stem is timestamp-hash-slug and ignores update time', () => {
  const stem = rolloutSummaryFileStem(memory())
  assert.match(stem, /^2026-11-05T01-02-03-[0-9a-zA-Z]{4}-fix_upload_test$/)
  assert.equal(rolloutSummaryFileStem(memory({ sourceUpdatedAt: 1 })), stem)
})

test('file stem falls back to the prefix for missing or non-ASCII slugs', () => {
  assert.match(rolloutSummaryFileStem(memory({ rolloutSlug: null })), /^[0-9T-]+-[0-9a-zA-Z]{4}$/)
  assert.match(rolloutSummaryFileStem(memory({ rolloutSlug: '修复' })), /^[0-9T-]+-[0-9a-zA-Z]{4}$/)
  assert.ok(rolloutSummaryFileStem(memory({ rolloutSlug: 'x'.repeat(100) })).endsWith(`-${'x'.repeat(60)}`))
})

test('raw_memories.md follows the upstream layout', async () => {
  const { memoryRoot } = await tempMemoryRoot()
  await rebuildRawMemoriesFile(memoryRoot, [memory()])
  const body = await readFile(join(memoryRoot, 'raw_memories.md'), 'utf8')
  assert.ok(body.startsWith('# Raw Memories\n\nMerged stage-1 raw memories (stable ascending thread-id order):\n\n## Thread `dsh:session-alpha`\n'))
  assert.ok(body.includes('updated_at: 2026-11-07T10:00:03+00:00\n'))
  assert.ok(body.includes(`rollout_summary_file: ${rolloutSummaryFileStem(memory())}.md\n\nraw body\n`))
  await rebuildRawMemoriesFile(memoryRoot, [])
  assert.equal(await readFile(join(memoryRoot, 'raw_memories.md'), 'utf8'), '# Raw Memories\n\nNo raw memories yet.\n')
})

test('summary sync writes the header and prunes unselected files', async () => {
  const { memoryRoot } = await tempMemoryRoot()
  await ensureLayout(memoryRoot)
  await writeFile(join(memoryRoot, 'rollout_summaries', 'stale.md'), 'old')
  await syncRolloutSummaries(memoryRoot, [memory({ gitBranch: 'main' })])
  const names = await readdir(join(memoryRoot, 'rollout_summaries'))
  assert.deepEqual(names, [`${rolloutSummaryFileStem(memory())}.md`])
  assert.equal(
    await readFile(join(memoryRoot, 'rollout_summaries', names[0]), 'utf8'),
    'thread_id: dsh:session-alpha\nupdated_at: 2026-11-07T10:00:03+00:00\nrollout_path: dsh://session/session-alpha\ncwd: /tmp/a\ngit_branch: main\n\n# summary\n',
  )
})

test('layout refuses a symlinked root and removes symlinks inside it', async () => {
  const base = await makeTempDir('memories-link-')
  const target = join(base, 'target')
  await mkdir(target)
  await symlink(target, join(base, 'link'))
  await assert.rejects(ensureLayout(join(base, 'link')), /symbolic link/)

  const { memoryRoot } = await tempMemoryRoot()
  await symlink('/etc/hosts', join(memoryRoot, 'escape.md'))
  await ensureLayout(memoryRoot)
  assert.equal((await readdir(memoryRoot)).includes('escape.md'), false)
})
