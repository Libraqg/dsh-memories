import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { diffSinceLatestInit, ensureGitBaselineRepository, resetGitRepository } from '../../core/git-baseline.js'
import { makeTempDir } from '../helpers/fakes.js'

const ELEVEN_MIB = 11 * 1024 * 1024

async function workspace() {
  const root = await makeTempDir('baseline-')
  await writeFile(join(root, 'a.md'), 'one\n')
  return root
}

const statuses = (diff) => diff.changes.map((change) => `${change.status} ${change.path}`).sort()

test('a new baseline is empty, so every file reads as added', async () => {
  const root = await workspace()
  await mkdir(join(root, '记忆'))
  await writeFile(join(root, '记忆', '笔记.md'), '内容\n')
  await ensureGitBaselineRepository(root)
  const diff = await diffSinceLatestInit(root)
  assert.deepEqual(statuses(diff), ['A a.md', 'A 记忆/笔记.md'])
  assert.ok(diff.unifiedDiff.includes('+内容'))
})

test('after a reset only real changes appear', async () => {
  const root = await workspace()
  await writeFile(join(root, 'gone.md'), 'bye\n')
  await resetGitRepository(root)
  assert.deepEqual((await diffSinceLatestInit(root)).changes, [])
  await writeFile(join(root, 'a.md'), 'two\n')
  await rm(join(root, 'gone.md'))
  await writeFile(join(root, 'new.md'), 'hi\n')
  const diff = await diffSinceLatestInit(root)
  assert.deepEqual(statuses(diff), ['A new.md', 'D gone.md', 'M a.md'])
  assert.ok(diff.unifiedDiff.includes('-one'))
})

test('diffing does not disturb the baseline', async () => {
  const root = await workspace()
  await resetGitRepository(root)
  await writeFile(join(root, 'a.md'), 'two\n')
  await diffSinceLatestInit(root)
  assert.deepEqual(statuses(await diffSinceLatestInit(root)), ['M a.md'])
})

test('a reset keeps no history of deleted content', async () => {
  const root = await workspace()
  await resetGitRepository(root)
  await rm(join(root, 'a.md'))
  await resetGitRepository(root)
  assert.equal(execFileSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' }).trim().split('\n').length, 1)
  const objects = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch-check'], { cwd: root, encoding: 'utf8' })
  assert.equal(objects.includes(' blob '), false, 'the deleted file left no blob behind')
})

test('an untrusted baseline is replaced by an empty one', async () => {
  const root = await workspace()
  await resetGitRepository(root)
  await rm(join(root, '.git', 'memory-baseline-version'))
  assert.deepEqual(statuses(await diffSinceLatestInit(root)), ['A a.md'])
})

test('a gitfile is never followed', async () => {
  const root = await workspace()
  await writeFile(join(root, '.git'), 'gitdir: /tmp/somewhere-else\n')
  assert.deepEqual(statuses(await diffSinceLatestInit(root)), ['A a.md'])
})

test('oversized files stay out of the baseline', async () => {
  const root = await workspace()
  await truncate(await writeFile(join(root, 'huge.bin'), '').then(() => join(root, 'huge.bin')), ELEVEN_MIB)
  await resetGitRepository(root)
  assert.deepEqual((await diffSinceLatestInit(root)).changes, [])
})

test('a tracked file growing past the limit invalidates the baseline', async () => {
  const root = await workspace()
  await resetGitRepository(root)
  await truncate(join(root, 'a.md'), ELEVEN_MIB)
  await writeFile(join(root, 'b.md'), 'b\n')
  assert.deepEqual(statuses(await diffSinceLatestInit(root)), ['A b.md'])
})
