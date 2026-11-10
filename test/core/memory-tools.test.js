import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { LocalMemoriesBackend, MemoryToolError } from '../../core/memory-tools.js'
import { tempMemoryRoot } from '../helpers/fakes.js'

async function backend() {
  const { memoryRoot } = await tempMemoryRoot()
  await mkdir(join(memoryRoot, 'rollout_summaries'), { recursive: true })
  await mkdir(join(memoryRoot, '.git'), { recursive: true })
  await writeFile(join(memoryRoot, '.git', 'config'), 'secret needle')
  await writeFile(join(memoryRoot, 'MEMORY.md'), 'alpha one\nbeta two\ngamma Needle\ndelta\n')
  await writeFile(join(memoryRoot, 'rollout_summaries', 'a.md'), 'first needle\nsecond\nthird other\n')
  return { root: memoryRoot, memories: new LocalMemoriesBackend(memoryRoot) }
}

const rejects = (promise, pattern) => assert.rejects(promise, (error) => error instanceof MemoryToolError && pattern.test(error.message))

test('list shows the root without hidden entries and pages results', async () => {
  const { memories } = await backend()
  const all = await memories.list({})
  assert.deepEqual(all.entries.map((entry) => entry.path), ['MEMORY.md', 'rollout_summaries'])
  assert.deepEqual(all.entries.map((entry) => entry.entry_type), ['file', 'directory'])
  const first = await memories.list({ maxResults: 1 })
  assert.equal(first.truncated, true)
  assert.equal(first.next_cursor, '1')
  assert.deepEqual((await memories.list({ cursor: first.next_cursor })).entries.map((entry) => entry.path), ['rollout_summaries'])
  await rejects(memories.list({ cursor: 'x' }), /non-negative/)
  await rejects(memories.list({ cursor: '99' }), /exceeds/)
})

test('every path is confined to the root', async () => {
  const { root, memories } = await backend()
  await rejects(memories.read({ path: '../outside.md' }), /within the memories root/)
  await rejects(memories.read({ path: '/etc/hosts' }), /within the memories root/)
  await rejects(memories.read({ path: '.git/config' }), /not found/)
  await rejects(memories.read({ path: 'missing.md' }), /not found/)
  await symlink('/etc/hosts', join(root, 'link.md'))
  await rejects(memories.read({ path: 'link.md' }), /symlink/)
  assert.equal((await memories.list({})).entries.some((entry) => entry.path === 'link.md'), false)
  await rejects(memories.read({ path: 'rollout_summaries' }), /not a file/)
})

test('read honours line ranges and reports truncation', async () => {
  const { memories } = await backend()
  const part = await memories.read({ path: 'MEMORY.md', lineOffset: 2, maxLines: 2 })
  assert.deepEqual(part, { path: 'MEMORY.md', start_line_number: 2, content: 'beta two\ngamma Needle', truncated: true })
  assert.equal((await memories.read({ path: 'MEMORY.md' })).truncated, false)
  assert.equal((await memories.read({ path: 'MEMORY.md', maxTokens: 2 })).truncated, true)
  await rejects(memories.read({ path: 'MEMORY.md', lineOffset: 0 }), /line_offset/)
  await rejects(memories.read({ path: 'MEMORY.md', lineOffset: 50 }), /exceeds/)
})

test('search finds lines across files, case-insensitively, skipping hidden files', async () => {
  const { memories } = await backend()
  const result = await memories.search({ queries: ['needle'] })
  assert.deepEqual(result.matches.map((match) => [match.path, match.match_line_number]), [['MEMORY.md', 3], ['rollout_summaries/a.md', 1]])
  assert.deepEqual((await memories.search({ queries: ['needle'], caseSensitive: true })).matches.length, 1)
  const withContext = await memories.search({ queries: ['beta'], contextLines: 1 })
  assert.equal(withContext.matches[0].content, 'alpha one\nbeta two\ngamma Needle')
  assert.equal(withContext.matches[0].content_start_line_number, 1)
})

test('search combines queries by mode', async () => {
  const { memories } = await backend()
  assert.equal((await memories.search({ queries: ['beta', 'two'], matchMode: { type: 'all_on_same_line' } })).matches.length, 1)
  assert.equal((await memories.search({ queries: ['beta', 'gamma'], matchMode: { type: 'all_on_same_line' } })).matches.length, 0)
  const window = await memories.search({ queries: ['beta', 'gamma'], matchMode: { type: 'all_within_lines', line_count: 2 } })
  assert.deepEqual(window.matches.map((match) => [match.match_line_number, match.content, match.matched_queries]), [[2, 'beta two\ngamma Needle', ['beta', 'gamma']]])
  assert.equal((await memories.search({ queries: ['alpha', 'gamma'], matchMode: { type: 'all_within_lines', line_count: 2 } })).matches.length, 0)
  await rejects(memories.search({ queries: ['  '] }), /empty/)
  await rejects(memories.search({ queries: ['a'], matchMode: { type: 'all_within_lines', line_count: 0 } }), /positive/)
})

test('normalized search ignores punctuation and keeps CJK', async () => {
  const { root, memories } = await backend()
  await writeFile(join(root, 'cjk.md'), '不要用 pandas，用 polars\nsnake_case_name\n')
  assert.equal((await memories.search({ queries: ['snakecase'], normalized: true })).matches.length, 1)
  assert.equal((await memories.search({ queries: ['用polars'], normalized: true })).matches.length, 1)
})

test('ad-hoc notes are validated and append-only', async () => {
  const { root, memories } = await backend()
  const filename = '2026-11-09T10-00-00-use-tabs.md'
  await memories.addAdHocNote({ filename, note: 'Always use tabs.' })
  assert.equal(await readFile(join(root, 'extensions/ad_hoc/notes', filename), 'utf8'), 'Always use tabs.')
  await rejects(memories.addAdHocNote({ filename, note: 'again' }), /already exists/)
  await rejects(memories.addAdHocNote({ filename: '../evil.md', note: 'x' }), /must use/)
  await rejects(memories.addAdHocNote({ filename: '2026-11-09T10-00-00-Bad_Slug.md', note: 'x' }), /must use/)
  await rejects(memories.addAdHocNote({ filename: '2026-11-09T10-00-01-ok.md', note: '  ' }), /empty/)
})
