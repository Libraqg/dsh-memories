import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { resolveDshConfig } from '../../../adapters/dsh/config.js'
import { apply, memoryReadPath } from '../../../adapters/dsh/index.js'
import { MemoryStore, systemClock } from '../../../core/index.js'
import { fixtureSessionQuery, tempMemoryRoot } from '../../helpers/fakes.js'

async function plugin(configOverrides = {}, ctxOverrides = {}) {
  const paths = await tempMemoryRoot()
  const listeners = new Map()
  const disposers = []
  const saved = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on: (name, listener) => listeners.set(name, listener),
    effect: (body) => disposers.push(body()),
    tools: { registered: [], register: (definition) => ctx.tools.registered.push(definition) },
    commands: { registered: [], register: (command) => (ctx.commands.registered.push(command), () => {}) },
    llm: {
      calls: 0,
      listProviders: () => ((ctx.llm.calls += 1), [{ id: 'deepseek-official' }]),
      listModels: async () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    },
    agents: { withoutInitiator: (body) => body() },
    approval: {},
    sessionQuery: await fixtureSessionQuery(),
    fiber: { entry: { id: 'memories' } },
    get: (name) => (name === 'configEditor' ? { edit: async (_entry, change) => saved.push(change({ existing: true })) } : undefined),
    ...ctxOverrides,
  }
  apply(ctx, { ...paths, minRolloutIdleHours: 1, ...configOverrides })
  const emit = (name, ...args) => listeners.get(name)(...args)
  const command = (rawInput) => ctx.commands.registered[0].handler({ rawInput })
  return { ctx, paths, emit, command, saved, dispose: () => disposers.forEach((dispose) => dispose?.()) }
}

const rootSession = (id = 'session-root') => ({ id, header: { id, delegationDepth: 0 } })
const childSession = { id: 'session-child', header: { id: 'session-child', delegationDepth: 1, parentSession: 'session-root' } }

function agentFor(header) {
  const sections = []
  return { agent: { session: { header }, ctx: { systemPrompt: { section: (entry) => sections.push(entry) } } }, sections }
}

test('default routes use the DeepSeek API, and each stage can differ', () => {
  const defaults = resolveDshConfig({})
  assert.deepEqual(defaults.extractModel, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(defaults.consolidationModel, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.ok(defaults.memoryRoot.endsWith('.dsh/memories'))
  const custom = resolveDshConfig({ extractModel: { provider: 'claude', model: 'haiku', reasoningEffort: 'low' }, memoryRoot: ' /tmp/m ' })
  assert.deepEqual(custom.extractModel, { provider: 'claude', model: 'haiku', reasoningEffort: 'low' })
  assert.equal(custom.memoryRoot, '/tmp/m')
  assert.deepEqual(resolveDshConfig({ extractModel: { provider: 'x' } }).extractModel.provider, 'deepseek-official', 'a half-filled route falls back')
})

test('a new agent gets the summary as a frozen system section', async () => {
  const { paths, emit, dispose } = await plugin()
  await writeFile(join(paths.memoryRoot, 'memory_summary.md'), 'v1\nfirst\n')
  const { agent, sections } = agentFor({ id: 'a', delegationDepth: 0 })
  await emit('agent/created', { agent })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].interpolate, false)
  assert.ok(sections[0].text.includes('v1\nfirst'))
  await writeFile(join(paths.memoryRoot, 'memory_summary.md'), 'v1\nsecond\n')
  assert.ok(sections[0].text.includes('first'), 'later consolidations do not touch a live prompt')
  dispose()
})

test('no summary, the consolidation agent and disabled reads get nothing injected', async () => {
  const first = await plugin()
  const empty = agentFor({ id: 'a', delegationDepth: 0 })
  await first.emit('agent/created', { agent: empty.agent })
  assert.equal(empty.sections.length, 0)

  await writeFile(join(first.paths.memoryRoot, 'memory_summary.md'), 'v1\n')
  const worker = agentFor({ id: 'w', origin: 'subagent', cwd: await (await import('node:fs/promises')).realpath(first.paths.memoryRoot) })
  await first.emit('agent/created', { agent: worker.agent })
  assert.equal(worker.sections.length, 0)

  const disabled = await plugin({ useMemories: false })
  await writeFile(join(disabled.paths.memoryRoot, 'memory_summary.md'), 'v1\n')
  const agent = agentFor({ id: 'a', delegationDepth: 0 })
  await disabled.emit('agent/created', { agent: agent.agent })
  assert.equal(agent.sections.length, 0)
  assert.equal(disabled.ctx.tools.registered.length, 0)
  first.dispose()
  disabled.dispose()
})

test('registers the four tools with plain definitions', async () => {
  const { ctx, paths, dispose } = await plugin()
  const names = ctx.tools.registered.map((definition) => definition.name)
  assert.deepEqual(names, ['memories_list', 'memories_read', 'memories_search', 'memories_add_ad_hoc_note'])
  for (const definition of ctx.tools.registered) {
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }
  await writeFile(join(paths.memoryRoot, 'MEMORY.md'), 'hello\n')
  const read = ctx.tools.registered[1]
  const value = await read.execute({ path: 'MEMORY.md' })
  assert.equal(JSON.parse(value).content, 'hello\n')
  assert.deepEqual(read.output.render({}, value), [{ type: 'text', text: value }])
  await assert.rejects(read.execute({}), /path is required/)
  await assert.rejects(read.execute({ path: 'MEMORY.md', max_lines: 0 }), /positive integer/)
  dispose()
})

test('the memory tools work before any memory exists', async () => {
  const paths = await tempMemoryRoot()
  const { rm } = await import('node:fs/promises')
  await rm(paths.memoryRoot, { recursive: true })
  const { ctx, dispose } = await plugin(paths)
  const list = JSON.parse(await ctx.tools.registered[0].execute({}))
  assert.deepEqual(list.entries, [])
  const search = JSON.parse(await ctx.tools.registered[2].execute({ queries: ['anything'] }))
  assert.deepEqual(search.matches, [])
  dispose()
})

test('a root turn starts one pipeline at a time; subagent turns start none', async () => {
  const { ctx, emit, dispose } = await plugin()
  emit('session/event', childSession, { type: 'turn/start' })
  await delay(20)
  assert.equal(ctx.llm.calls, 0)
  emit('session/event', rootSession(), { type: 'turn/start' })
  emit('session/event', rootSession(), { type: 'turn/start' })
  await delay(40)
  assert.equal(ctx.llm.calls, 1, 'the overlapping turn added no second pass')
  emit('session/event', rootSession(), { type: 'turn/start' })
  await delay(40)
  assert.equal(ctx.llm.calls, 2, 'the next turn runs again')
  dispose()
})

test('generation can be switched off without losing reads', async () => {
  const { ctx, emit, dispose } = await plugin({ generateMemories: false })
  emit('session/event', rootSession(), { type: 'turn/start' })
  await delay(20)
  assert.equal(ctx.llm.calls, 0)
  assert.equal(ctx.tools.registered.length, 4)
  dispose()
})

test('conversation events invalidate the cached thread summary', async () => {
  // An age window of zero keeps every fixture unclaimed, so reads below are scans only.
  const { ctx, emit, dispose } = await plugin({ maxRolloutAgeDays: 0 })
  const session = rootSession('session-alpha')
  ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1000 } })
  emit('session/event', session, { type: 'turn/start' })
  await delay(60)
  const afterFirstScan = ctx.sessionQuery.reads
  assert.ok(afterFirstScan >= 4)
  emit('session/event', session, { type: 'turn/start' })
  await delay(60)
  assert.equal(ctx.sessionQuery.reads, afterFirstScan, 'an unchanged session is not read twice')
  emit('session/event', session, { type: 'assistant/message' })
  // A turn that arrives during a running pass is skipped by design, so keep asking.
  for (let attempt = 0; attempt < 100 && ctx.sessionQuery.reads === afterFirstScan; attempt += 1) {
    emit('session/event', session, { type: 'turn/start' })
    await delay(20)
  }
  assert.equal(ctx.sessionQuery.reads, afterFirstScan + 1, 'the dirty session is read again')
  dispose()
})

test('tool paths resolve to memory-relative reads', () => {
  const roots = ['/data/memories']
  assert.equal(memoryReadPath(roots, 'memories_read', { path: 'rollout_summaries/a.md' }), 'rollout_summaries/a.md')
  assert.equal(memoryReadPath(roots, 'read', { file_path: '/data/memories/rollout_summaries/a.md' }), 'rollout_summaries/a.md')
  assert.equal(memoryReadPath(roots, 'read', JSON.stringify({ file_path: '/data/memories/MEMORY.md' })), 'MEMORY.md')
  assert.equal(memoryReadPath(roots, 'read', { file_path: '/elsewhere/a.md' }), undefined)
  assert.equal(memoryReadPath(roots, 'read', { file_path: 'relative.md' }), undefined)
  assert.equal(memoryReadPath(roots, 'bash', { command: 'cat x' }), undefined)
  assert.equal(memoryReadPath(roots, 'read', '{broken'), undefined)
})

test('a summary read counts once per turn and again next turn', async () => {
  const { paths, emit, dispose } = await plugin({ generateMemories: false })
  const seed = new MemoryStore(paths.stateDbPath, systemClock)
  const threadId = 'dsh:session-x'
  const { ownershipToken } = seed.tryClaimStage1Job({ threadId, workerId: 'w', sourceUpdatedAt: 100, leaseSeconds: 60, maxRunningJobs: 2 })
  seed.markStage1JobSucceeded({ threadId, ownershipToken, sourceUpdatedAt: 100, rawMemory: 'r', rolloutSummary: 's', rolloutSlug: null })
  seed.close()
  await (await import('node:fs/promises')).mkdir(join(paths.memoryRoot, 'rollout_summaries'), { recursive: true })
  await writeFile(join(paths.memoryRoot, 'rollout_summaries', 'x.md'), `thread_id: ${threadId}\n\nbody\n`)

  const session = rootSession()
  const read = { type: 'tool/call', data: { name: 'memories_read', arguments: JSON.stringify({ path: 'rollout_summaries/x.md' }) } }
  const usage = () => {
    const db = new DatabaseSync(paths.stateDbPath)
    const row = db.prepare('SELECT usage_count FROM stage1_outputs WHERE thread_id = ?').get(threadId)
    db.close()
    return row.usage_count
  }
  emit('session/event', session, read)
  emit('session/event', session, read)
  await delay(20)
  assert.equal(usage(), 1)
  emit('session/event', session, { type: 'turn/start' })
  emit('session/event', session, read)
  await delay(20)
  assert.equal(usage(), 2)
  dispose()
})

test('the command reports status and path, and guards reset', async () => {
  const { command, paths, dispose } = await plugin()
  const status = await command('')
  assert.equal(status.kind, 'success')
  assert.ok(status.text.includes(paths.memoryRoot))
  assert.ok(status.text.includes('Extraction model: deepseek-official/deepseek-flash'))
  assert.ok(status.text.includes('Consolidation: not run yet'))
  assert.equal((await command('path')).text.trim(), paths.memoryRoot)
  assert.equal((await command('reset')).kind, 'error')
  assert.equal((await command('reset --confirm')).kind, 'success')
  assert.equal((await command('nonsense')).kind, 'error')
  dispose()
})

test('models are listed and saved through the config editor', async () => {
  const { command, saved, dispose } = await plugin()
  assert.ok((await command('model list')).text.includes('deepseek-official: deepseek-flash, deepseek-v4-pro'))
  assert.equal((await command('model set extract deepseek-official deepseek-v4-pro high')).kind, 'success')
  assert.deepEqual(saved[0], { existing: true, extractModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } })
  assert.equal((await command('model clear extract')).kind, 'success')
  assert.deepEqual(saved[1], { existing: true })
  assert.match((await command('model set extract nope x')).text, /not registered/)
  assert.equal((await command('model set wrong a b')).kind, 'error')
  dispose()
})
