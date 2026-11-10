import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { consolidationToolDefinitions, globToRegExp } from '../../../adapters/dsh/consolidation-tools.js'
import { MemoryToolError } from '../../../core/index.js'
import { makeTempDir } from '../../helpers/fakes.js'

async function setup() {
  const base = await realpath(await makeTempDir('consolidation-tools-'))
  const root = join(base, 'memories')
  await mkdir(join(root, 'rollout_summaries'), { recursive: true })
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'config'), 'needle')
  await writeFile(join(root, 'MEMORY.md'), 'alpha\nneedle one\nomega\n')
  await writeFile(join(root, 'rollout_summaries', 'a.md'), 'needle two\n')
  await writeFile(join(base, 'outside.md'), 'needle outside')
  const tools = Object.fromEntries(consolidationToolDefinitions([root]).map((definition) => [definition.name, definition]))
  return { base, root, tools }
}

const refused = (promise, pattern) => assert.rejects(promise, (error) => error instanceof MemoryToolError && pattern.test(error.message))
const exists = (path) => stat(path).then(() => true, () => false)

test('definitions have the shape DSH registers', async () => {
  const { tools } = await setup()
  assert.deepEqual(Object.keys(tools), ['read', 'write', 'edit', 'glob', 'grep'])
  for (const definition of Object.values(tools)) {
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('read numbers lines, pages, and accepts relative or absolute paths', async () => {
  const { root, tools } = await setup()
  assert.equal(await tools.read.execute({ file_path: 'MEMORY.md', limit: 1 }), '1\talpha\n[4 lines in total; continue with offset 2]')
  assert.equal(await tools.read.execute({ file_path: join(root, 'MEMORY.md'), offset: 2, limit: 1 }), '2\tneedle one\n[4 lines in total; continue with offset 3]')
})

test('write creates parents and edit requires a unique match', async () => {
  const { root, tools } = await setup()
  await tools.write.execute({ file_path: 'skills/x/SKILL.md', content: 'a a' })
  assert.equal(await readFile(join(root, 'skills/x/SKILL.md'), 'utf8'), 'a a')
  await refused(tools.edit.execute({ file_path: 'skills/x/SKILL.md', old_string: 'a', new_string: 'b' }), /2 times/)
  await tools.edit.execute({ file_path: 'skills/x/SKILL.md', old_string: 'a', new_string: '$&', replace_all: true })
  assert.equal(await readFile(join(root, 'skills/x/SKILL.md'), 'utf8'), '$& $&')
  await refused(tools.edit.execute({ file_path: 'MEMORY.md', old_string: 'missing', new_string: 'x' }), /not found/)
})

test('no tool can leave the root, touch .git, or follow a symlink', async () => {
  const { base, root, tools } = await setup()
  await refused(tools.read.execute({ file_path: join(base, 'outside.md') }), /outside/)
  await refused(tools.read.execute({ file_path: '../outside.md' }), /outside/)
  await refused(tools.write.execute({ file_path: '/etc/evil', content: 'x' }), /outside/)
  await refused(tools.write.execute({ file_path: `${root}-evil/x.md`, content: 'x' }), /outside/)
  await refused(tools.write.execute({ file_path: '.git/config', content: 'x' }), /off limits/)
  await refused(tools.edit.execute({ file_path: join(root, '.git/config'), old_string: 'n', new_string: 'x' }), /off limits/)
  // Case-insensitive volumes resolve these to the real .git directory.
  await refused(tools.write.execute({ file_path: '.GIT/config', content: 'x' }), /off limits/)
  await refused(tools.read.execute({ file_path: '.Git/config' }), /off limits/)
  await refused(tools.write.execute({ file_path: 'a/../.git./config', content: 'x' }), /off limits/)
  await refused(tools.write.execute({ file_path: '.git /config', content: 'x' }), /off limits/)
  assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), 'needle')
  await tools.write.execute({ file_path: '.github-notes.md', content: 'x' })
  await refused(tools.grep.execute({ pattern: 'needle', path: '/etc' }), /outside/)
  await refused(tools.glob.execute({ pattern: '../*' }), /inside/)
  await refused(tools.glob.execute({ pattern: '/etc/*' }), /inside/)
  await symlink(base, join(root, 'escape'))
  await refused(tools.read.execute({ file_path: 'escape/outside.md' }), /symbolic/)
  await refused(tools.write.execute({ file_path: 'escape/new.md', content: 'x' }), /symbolic/)
  assert.equal(await exists(join(base, 'new.md')), false)
})

test('glob and grep see the workspace but not .git', async () => {
  const { tools } = await setup()
  assert.equal(await tools.glob.execute({ pattern: '**/*.md' }), 'MEMORY.md\nrollout_summaries/a.md')
  assert.equal(await tools.glob.execute({ pattern: '*.md', path: 'rollout_summaries' }), 'rollout_summaries/a.md')
  assert.equal(await tools.glob.execute({ pattern: '*.txt' }), 'No files matched.')
  assert.equal(await tools.grep.execute({ pattern: 'needle' }), 'MEMORY.md:2:needle one\nrollout_summaries/a.md:1:needle two')
  assert.equal(await tools.grep.execute({ pattern: 'needle', include: 'a.md' }), 'rollout_summaries/a.md:1:needle two')
  assert.equal(await tools.grep.execute({ pattern: 'needle', path: 'MEMORY.md' }), 'MEMORY.md:2:needle one')
  await refused(tools.grep.execute({ pattern: '(' }), /regular expression/)
})

test('glob translation', () => {
  assert.ok(globToRegExp('**/*.md').test('a.md'))
  assert.ok(globToRegExp('**/*.md').test('x/y/a.md'))
  assert.equal(globToRegExp('*.md').test('x/a.md'), false)
  assert.ok(globToRegExp('a?.{md,txt}').test('ab.txt'))
  assert.equal(globToRegExp('a.md').test('axmd'), false)
})
