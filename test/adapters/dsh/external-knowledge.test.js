import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveExternalKnowledgePolicy } from '../../../adapters/dsh/config.js'
import { createDshSessionSource } from '../../../adapters/dsh/session-source.js'
import { MemoryStore, createExternalKnowledgePolicy, resolveMemoriesConfig, runMemoryPipeline } from '../../../core/index.js'
import { EXTRACT_ROUTE, FIXTURE_NOW_MS, fakeClock, fakeModel, fakeRunner, memoryJson, tempMemoryRoot } from '../../helpers/fakes.js'

const ROOT = '/data/Notes'
const policy = createExternalKnowledgePolicy({ root: ROOT, sessionExcludedPaths: ['personal'] })
const SECRET = 'CONTENT-FROM-THE-NOTES'
const DAY_AGO = FIXTURE_NOW_MS - 24 * 3_600_000

let seq = 0
const event = (type, data) => ({ type, seq: (seq += 1), time: DAY_AGO, data })
const user = (text, kind = 'user') => event('user/message', { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind } })
const assistant = (text) => event('assistant/message', { message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }] } })
const call = (callId, name, args) => event('tool/call', { callId, name, arguments: JSON.stringify(args) })
const result = (callId, text, isError = false) => event('tool/result', { message: { id: `t${seq}`, role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text }] } })

function source(sessions, options = { externalKnowledge: policy }) {
  const byId = new Map(sessions.map((session) => [session.header.id, session]))
  const sessionQuery = {
    listSessions: async () => sessions.map(({ header }) => ({ header })),
    readSession: async (id) => ({ session: byId.get(id).header, inheritedEventCount: 0, events: byId.get(id).events }),
  }
  return createDshSessionSource({ sessionQuery }, options)
}

const session = (id, events, header = {}) => ({ header: { id, createdAt: DAY_AGO - 1000, cwd: '/work/app', delegationDepth: 0, ...header }, events: [user('please help'), ...events] })

async function modeOf(sessions, id = 'root') {
  const threads = await source(sessions).listThreads()
  return threads.find((thread) => thread.id === `dsh:${id}`)?.memoryMode
}

test('an ordinary session is untouched', async () => {
  const events = [call('c1', 'bash', { command: 'npm test' }), result('c1', 'ok'), assistant('done')]
  const dsh = source([session('root', events)])
  assert.equal((await dsh.listThreads())[0].memoryMode, 'enabled')
  const items = await dsh.readRollout('dsh:root')
  assert.deepEqual(items[1], { type: 'function_call', name: 'bash', arguments: '{"command":"npm test"}', call_id: 'c1' })
  assert.equal(items[2].output.body, 'ok')
})

test('reading the knowledge base leaves the session but removes the content', async () => {
  const events = [
    call('c1', 'read', { file_path: `${ROOT}/research/project-b.md` }),
    result('c1', SECRET),
    assistant('We will use plan B.'),
  ]
  const dsh = source([session('root', events)])
  assert.equal((await dsh.listThreads())[0].memoryMode, 'enabled')
  const items = await dsh.readRollout('dsh:root')
  assert.deepEqual(JSON.parse(items[1].arguments), { omitted: '[Notes content omitted: research/project-b.md]' })
  assert.equal(items[2].output.body, '[Notes content omitted: research/project-b.md]')
  assert.equal(JSON.stringify(items).includes(SECRET), false)
  assert.ok(JSON.stringify(items).includes('We will use plan B.'), 'the conversation survives')
})

test('every tool that names the knowledge base is covered, including writes', async () => {
  const events = [
    call('c1', 'bash', { command: `ls -1 ${ROOT}`, description: 'list' }),
    result('c1', SECRET),
    call('c2', 'grep', { pattern: 'x', path: ROOT }),
    result('c2', SECRET),
    call('c3', 'write', { file_path: `${ROOT}/log/2026-11.md`, content: SECRET }),
    result('c3', 'written'),
    call('c4', 'some_mcp_search', { query: 'Notes/research/a.md' }),
    result('c4', SECRET),
  ]
  const text = JSON.stringify(await source([session('root', events)]).readRollout('dsh:root'))
  assert.equal(text.includes(SECRET), false)
})

test('output that reveals the knowledge base is removed even if the call did not name it', async () => {
  const events = [call('c1', 'bash', { command: 'rg TAI ~/Documents' }), result('c1', `/home/me/Notes/research/a.md:3:${SECRET}`)]
  const items = await source([session('root', events)]).readRollout('dsh:root')
  assert.equal(JSON.stringify(items).includes(SECRET), false)
  assert.equal(items[2].output.body, '[Notes content omitted: research/a.md]')
})

test('touching an excluded path removes the whole session', async () => {
  const viaRead = [call('c1', 'read', { file_path: `${ROOT}/personal/job.md` }), result('c1', SECRET)]
  const viaBash = [call('c1', 'bash', { command: `cat ${ROOT}/personal/job.md` }), result('c1', SECRET)]
  const viaOutput = [call('c1', 'bash', { command: 'rg x ~/Documents' }), result('c1', `/h/Notes/personal/job.md:1:${SECRET}`)]
  const viaText = [assistant(`I read ${ROOT}/personal/job.md for you.`)]
  for (const events of [viaRead, viaBash, viaOutput, viaText]) {
    assert.equal(await modeOf([session('root', events)]), 'polluted')
  }
  assert.equal(await modeOf([{ ...session('root', []), events: [user(`see ${ROOT}/personal/a.md`)] }]), 'polluted')
})

test('injected instructions that mention the path do not exclude a session', async () => {
  const sessions = [{ ...session('root', []), events: [user(`Read ${ROOT}/personal/ when relevant`, 'agent-instructions'), user('hello')] }]
  assert.equal(await modeOf(sessions), 'enabled')
})

test('a session started inside the knowledge base loses its tool content', async () => {
  const events = [call('c1', 'bash', { command: 'cat research/a.md' }), result('c1', SECRET), assistant('summary')]
  const dsh = source([session('root', events, { cwd: `${ROOT}/research` })])
  assert.equal((await dsh.listThreads())[0].memoryMode, 'enabled')
  const items = await dsh.readRollout('dsh:root')
  assert.equal(JSON.stringify(items).includes(SECRET), false)
  assert.ok(JSON.stringify(items).includes('summary'))
})

test('a session started in, or touching, an excluded path from inside is removed', async () => {
  assert.equal(await modeOf([session('root', [], { cwd: `${ROOT}/personal` })]), 'polluted')
  const relative = [call('c1', 'bash', { command: 'cat personal/job.md' }), result('c1', SECRET)]
  assert.equal(await modeOf([session('root', relative, { cwd: ROOT })]), 'polluted')
  assert.equal(await modeOf([session('root', relative, { cwd: '/work/app' })]), 'enabled', 'an unrelated personal/ folder is fine')
})

test('working_directory moves the boundary in and out', async () => {
  const events = [
    call('c0', 'bash', { command: 'pwd' }),
    result('c0', 'before'),
    call('c1', 'working_directory', { cd: '../data' }),
    result('c1', `${ROOT}/research`),
    call('c2', 'bash', { command: 'cat a.md' }),
    result('c2', SECRET),
    call('c3', 'working_directory', { cd: '/work/app' }),
    result('c3', '/work/app'),
    call('c4', 'bash', { command: 'npm test' }),
    result('c4', 'after'),
  ]
  const items = await source([session('root', events)]).readRollout('dsh:root')
  const outputs = items.filter((item) => item.type === 'function_call_output').map((item) => item.output.body)
  assert.equal(outputs[0], 'before')
  assert.equal(outputs[2].includes(SECRET), false)
  assert.equal(outputs[4], 'after')
})

test('moving into an excluded path removes the session', async () => {
  const events = [call('c1', 'working_directory', { cd: 'personal' }), result('c1', `${ROOT}/personal`)]
  assert.equal(await modeOf([session('root', events)]), 'polluted')
})

test('a child that reads an excluded path taints its root, through several levels', async () => {
  const leak = [call('c1', 'read', { file_path: `${ROOT}/personal/job.md` }), result('c1', SECRET)]
  const sessions = [
    session('root', []),
    session('middle', [], { delegationDepth: 1, parentSession: 'root' }),
    session('leaf', leak, { delegationDepth: 2, parentSession: 'middle' }),
    session('unrelated', []),
  ]
  const threads = await source(sessions).listThreads()
  assert.deepEqual(threads.map((thread) => [thread.id, thread.memoryMode]), [['dsh:root', 'polluted'], ['dsh:unrelated', 'enabled']])
})

test('a child that only reads other notes does not exclude its root', async () => {
  const read = [call('c1', 'read', { file_path: `${ROOT}/research/a.md` }), result('c1', SECRET)]
  assert.equal(await modeOf([session('root', []), session('child', read, { delegationDepth: 1, parentSession: 'root' })]), 'enabled')
})

test('the consolidation agent never taints its trigger session', async () => {
  const worker = { header: { id: 'worker', createdAt: DAY_AGO, delegationDepth: 1, parentSession: 'root', origin: 'subagent' }, events: [user('consolidate', 'memories'), call('c1', 'read', { file_path: 'x' }), result('c1', `${ROOT}/personal/a.md`)] }
  assert.equal(await modeOf([session('root', []), worker]), 'enabled')
})

test('a later excluded read is picked up after the session is marked dirty', async () => {
  const live = session('root', [assistant('fine')])
  const dsh = source([live])
  assert.equal((await dsh.listThreads())[0].memoryMode, 'enabled')
  live.events.push(call('c1', 'read', { file_path: `${ROOT}/personal/a.md` }), result('c1', SECRET))
  dsh.markDirty('root')
  assert.equal((await dsh.listThreads())[0].memoryMode, 'polluted')
})

test('without a policy nothing is filtered', async () => {
  const events = [call('c1', 'read', { file_path: `${ROOT}/personal/job.md` }), result('c1', SECRET)]
  const dsh = source([session('root', events)], {})
  assert.equal((await dsh.listThreads())[0].memoryMode, 'enabled')
  assert.ok(JSON.stringify(await dsh.readRollout('dsh:root')).includes(SECRET))
})

test('the filter is off unless a knowledge base is configured', () => {
  assert.equal(resolveExternalKnowledgePolicy({}), undefined)
  assert.equal(resolveExternalKnowledgePolicy({ externalKnowledge: false }), undefined)
  assert.equal(resolveExternalKnowledgePolicy({ externalKnowledge: { root: '  ' } }), undefined)
  const policy = resolveExternalKnowledgePolicy({ externalKnowledge: { root: '/x/Vault', sessionExcludedPaths: ['private'] } })
  assert.equal(policy.scan('/x/Vault/private/a').excludesSession, true)
  assert.deepEqual(policy.scan('cat /x/Vault/projects/alpha.md').paths, ['projects/alpha.md'])
})

test('a root under the home directory may be written with ~', async () => {
  const { homedir } = await import('node:os')
  const policy = resolveExternalKnowledgePolicy({ externalKnowledge: { root: '~/Notes', sessionExcludedPaths: ['private'] } })
  assert.equal(policy.scan(`cat ${homedir()}/Notes/private/a.md`).excludesSession, true)
  assert.equal(resolveExternalKnowledgePolicy({ externalKnowledge: { root: '/x/Vault' } }).scan('/x/Vault/private/a').excludesSession, false, 'nothing is excluded by default')
})

test('through the pipeline: excluded sessions are never sent, and are forgotten once they become excluded', async () => {
  const paths = await tempMemoryRoot()
  const clock = fakeClock()
  const config = resolveMemoriesConfig({ ...paths, extractModel: EXTRACT_ROUTE })
  const live = session('root', [call('c1', 'read', { file_path: `${ROOT}/research/a.md` }), result('c1', SECRET), assistant('plan B')])
  const dsh = source([live])
  const model = fakeModel(() => memoryJson('root'))
  const runner = fakeRunner()
  const deps = { config, clock, store: new MemoryStore(config.stateDbPath, clock), source: dsh, model, runner }
  const run = () => runMemoryPipeline(deps, { currentThreadId: 'dsh:current' })

  await run()
  assert.equal(model.requests.length, 1)
  assert.equal(model.requests[0].input.includes(SECRET), false)
  assert.ok(model.requests[0].input.includes('[Notes content omitted: research/a.md]'))
  assert.equal((await readdir(join(config.memoryRoot, 'rollout_summaries'))).length, 1)

  live.events.push(call('c2', 'read', { file_path: `${ROOT}/personal/job.md` }), result('c2', SECRET))
  dsh.markDirty('root')
  clock.advanceHours(7)
  await run()
  assert.equal(model.requests.length, 1, 'an excluded session is not extracted again')
  assert.deepEqual(await readdir(join(config.memoryRoot, 'rollout_summaries')), [])
  assert.match(runner.requests[1].diff, /- D rollout_summaries\/.*\.md/, 'the agent is told to forget it')
})
