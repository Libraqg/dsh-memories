import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createExternalKnowledgePolicy } from '../../core/external-knowledge.js'

const policy = createExternalKnowledgePolicy({ root: '/data/Notes', sessionExcludedPaths: ['personal'] })

test('finds references under any parent spelling', () => {
  for (const text of ['cat /data/Notes/a/b.md', 'cat ~/x/Notes/a/b.md', 'cat $HOME/Notes/a/b.md', 'cat Notes/a/b.md', '"file_path":"/data/Notes/a/b.md"']) {
    assert.deepEqual(policy.scan(text).paths, ['a/b.md'], text)
  }
  assert.deepEqual(policy.scan('ls -1 /data/Notes').paths, ['.'])
  assert.deepEqual(policy.scan('/data/Notes/').paths, ['.'])
})

test('ignores look-alike names and plain words', () => {
  for (const text of ['/data/Notes-old/a.md', '/data/MyNotes/a.md', 'Release Notes are here', 'my_Notes/a.md', '/data/Notes2/a']) {
    assert.deepEqual(policy.scan(text).paths, [], text)
  }
})

test('a path stops at punctuation, so matched lines do not leak into it', () => {
  assert.deepEqual(policy.scan('/data/Notes/a.md:3:some text').paths, ['a.md'])
  assert.deepEqual(policy.scan('见 /data/Notes/笔记.md，然后').paths, ['笔记.md'])
  assert.deepEqual(policy.scan('(/data/Notes/a.md) and "/data/Notes/b.md"').paths, ['a.md', 'b.md'])
})

test('excluded paths are matched by segment', () => {
  assert.equal(policy.scan('cat /data/Notes/personal/job.md').excludesSession, true)
  assert.equal(policy.scan('ls /data/Notes/personal').excludesSession, true)
  assert.equal(policy.scan('cat /data/Notes/personal-old/job.md').excludesSession, false)
  assert.equal(policy.scan('cat /data/Notes/research/personal.md').excludesSession, false)
})

test('locate reports where a working directory is', () => {
  assert.deepEqual(policy.locate('/work/project'), { inside: false, excludesSession: false })
  assert.deepEqual(policy.locate('/data/Notes/research'), { inside: true, excludesSession: false })
  assert.deepEqual(policy.locate('/data/Notes/personal/x'), { inside: true, excludesSession: true })
  assert.deepEqual(policy.locate(undefined), { inside: false, excludesSession: false })
})

test('relative references to excluded paths are recognized', () => {
  assert.equal(policy.mentionsExcludedRelative('cat personal/job.md'), true)
  assert.equal(policy.mentionsExcludedRelative('ls personal'), true)
  assert.equal(policy.mentionsExcludedRelative('cat impersonal/job.md'), false)
  assert.equal(policy.mentionsExcludedRelative('cat personal-old/job.md'), false)
})

test('the placeholder names the files but carries no content', () => {
  assert.equal(policy.placeholder(new Set(['b.md', 'a.md'])), '[Notes content omitted: a.md, b.md]')
})

test('names with regex characters are matched literally', () => {
  const odd = createExternalKnowledgePolicy({ root: '/x/My.Notes(1)' })
  assert.deepEqual(odd.scan('cat /x/My.Notes(1)/a.md').paths, ['a.md'])
  assert.deepEqual(odd.scan('cat /x/MyXNotes(1)/a.md').paths, [])
})
