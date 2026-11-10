import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { findBoundaryViolations } from '../scripts/check-boundaries.js'
import { REPO_ROOT, makeTempDir } from './helpers/fakes.js'

test('the core depends on nothing but node and itself', () => {
  assert.deepEqual(findBoundaryViolations(join(REPO_ROOT, 'core')), [])
})

test('the checker flags harness imports and escapes from the core', async () => {
  const directory = await makeTempDir('boundary-')
  await writeFile(join(directory, 'bad.js'), `import a from '@deepseek-ai/dsh-llm'\nimport b from '../adapters/dsh/x.js'\nimport c from 'node:fs'\nimport d from './ok.js'\n`)
  const violations = findBoundaryViolations(directory)
  assert.equal(violations.length, 2)
  assert.match(violations[0], /@deepseek-ai/)
  assert.match(violations[1], /adapters/)
})
