import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseStageOneOutput } from '../../core/phase1-output.js'
import { renderTemplate, rolloutTokenLimit } from '../../core/prompts.js'
import { redactSecrets } from '../../core/redact.js'
import { sanitizeRolloutItem, selectRecentRolloutItems } from '../../core/rollout-input.js'
import { truncateTextToTokens } from '../../core/truncate.js'
import { userItem } from '../helpers/fakes.js'

test('redacts the upstream credential shapes', () => {
  assert.equal(redactSecrets('Bearer abcde+fghijklmnopqrstuvwxyz012345'), 'Bearer [REDACTED_SECRET]')
  assert.equal(redactSecrets('authorization: bEaReR\tabcdefghijklmnop'), 'authorization: Bearer [REDACTED_SECRET]')
  assert.equal(redactSecrets('{"token":"sk-abcdefghijklmnopqrstuvwxyz123456"}').includes('sk-abc'), false)
  assert.equal(redactSecrets('use AKIAABCDEFGHIJKLMNOP now'), 'use [REDACTED_SECRET] now')
  assert.equal(redactSecrets('password = "hunter2hunter2"'), 'password = "[REDACTED_SECRET]"')
})

test('leaves upstream false positives alone', () => {
  for (const input of ['Bearer of good news', 'Bearer abcdefghijklmno', 'NotABearer abcdefghijklmnop', 'Bearer\nabcdefghijklmnop']) {
    assert.equal(redactSecrets(input), input)
  }
})

test('truncation keeps head and tail on UTF-8 boundaries', () => {
  const text = '记忆'.repeat(100)
  const result = truncateTextToTokens(text, 10)
  assert.equal(result, `${'记忆'.repeat(3)}…140 tokens truncated…${'记忆'.repeat(3)}`)
  assert.equal(result.includes('�'), false)
  assert.equal(truncateTextToTokens('short', 10), 'short')
})

test('rollout token limit is 70% of the effective window', () => {
  assert.equal(rolloutTokenLimit(1_000_000), 665_000)
  assert.equal(rolloutTokenLimit(undefined), 150_000)
})

test('template values are not re-expanded and missing variables throw', () => {
  assert.equal(renderTemplate('a {{ x }}', { x: '{{ y }}' }), 'a {{ y }}')
  assert.throws(() => renderTemplate('{{ nope }}', {}), /nope/)
})

test('stage-one output contract', () => {
  const parsed = parseStageOneOutput('```json\n{"raw_memory":"r sk-abcdefghijklmnopqrstuvwxyz123456","rollout_summary":"s","rollout_slug":null}\n```')
  assert.deepEqual(parsed, { rawMemory: 'r [REDACTED_SECRET]', rolloutSummary: 's', rolloutSlug: null })
  assert.throws(() => parseStageOneOutput('not json'))
  assert.throws(() => parseStageOneOutput('{"raw_memory":"r","rollout_summary":"s","extra":1}'), /unknown field/)
  assert.throws(() => parseStageOneOutput('{"rollout_summary":"s"}'), /raw_memory/)
})

test('filtering drops developer messages and injected instruction blocks only', () => {
  assert.equal(sanitizeRolloutItem({ type: 'message', role: 'developer', content: [] }), undefined)
  assert.equal(sanitizeRolloutItem(userItem('# AGENTS.md instructions for /tmp\n<INSTRUCTIONS>x</INSTRUCTIONS>')), undefined)
  assert.equal(sanitizeRolloutItem(userItem('<skill>\nbody\n</skill>')), undefined)
  const environment = userItem('<environment_context><cwd>/tmp</cwd></environment_context>')
  assert.deepEqual(sanitizeRolloutItem(environment), environment)
})

test('selection keeps the newest items within the byte budget, in order, skipping oversized records', () => {
  const big = userItem('b'.repeat(2 * 1024 * 1024))
  assert.deepEqual(selectRecentRolloutItems([userItem('one'), big, userItem('two')]), [userItem('one'), userItem('two')])
  const chunk = () => userItem('c'.repeat(900 * 1024))
  const kept = selectRecentRolloutItems(Array.from({ length: 12 }, chunk))
  assert.equal(kept.length, 9)
})
