import assert from 'node:assert/strict'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createDshConsolidationRunner, withoutWorkspaceInstructions } from '../../../adapters/dsh/consolidation-runner.js'

function stubCtx({ turnEnd = { kind: 'completed' }, idle = Promise.resolve(), efforts = [{ id: 'medium' }] } = {}) {
  const state = { created: undefined, policy: undefined, followups: [], restricted: undefined, tools: [], appended: [], disposed: false, cancelled: undefined }
  const agent = {
    session: {
      append: (type, data) => state.appended.push([type, data]),
      snapshotEvents: () => (turnEnd === undefined ? [] : [{ type: 'turn/end', data: { reason: turnEnd } }]),
    },
    followup: (message) => state.followups.push(message),
    whenIdle: () => idle,
    cancel: (reason) => { state.cancelled = reason },
  }
  const agentCtx = {
    on: (name, listener, options) => { state.listeners = [name, listener, options] },
    tools: {
      register: (definition) => state.tools.push(definition),
      restrict: (filter) => { state.restricted = filter },
    },
  }
  const ctx = {
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts } }) },
    approval: { setPolicy: (target, policy) => { state.policy = [target === agent, policy] } },
    agents: {
      create: async (options) => {
        state.created = options
        options.setup(agentCtx, agent)
        return { agent, dispose: async () => { state.disposed = true } }
      },
    },
  }
  return { ctx, state }
}

async function request(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runner-'))
  return { root, prompt: 'consolidate', route: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, reasoningEffort: 'medium', currentThreadId: 'dsh:session-parent', signal: new AbortController().signal, ...extra }
}

test('creates an isolated hidden agent on the configured route', async () => {
  const { ctx, state } = stubCtx()
  const input = await request()
  assert.deepEqual(await createDshConsolidationRunner(ctx).run(input), { status: 'completed' })
  const canonical = await realpath(input.root)
  assert.deepEqual(state.created.meta, { cwd: canonical, parentSession: 'session-parent', origin: 'subagent', delegationDepth: 1 })
  assert.deepEqual(state.created.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'medium' })
  assert.deepEqual(state.restricted, { allow: [] }, 'every inherited tool is masked')
  assert.deepEqual(state.tools.map((definition) => definition.name), ['read', 'write', 'edit', 'glob', 'grep'])
  assert.deepEqual(state.appended, [['sandbox/mode', { mode: 'workspace-write' }]])
  assert.deepEqual(state.policy, [true, 'never'])
  assert.equal(state.followups[0].source.kind, 'memories')
  assert.equal(state.followups[0].role, 'user')
  assert.equal(typeof state.followups[0].id, 'string', 'replay rejects messages without an id')
  assert.equal(state.followups[0].content[0].text, 'consolidate')
  assert.equal(state.disposed, true)
})

test('workspace instructions never reach the agent', async () => {
  const { ctx, state } = stubCtx()
  await createDshConsolidationRunner(ctx).run(await request())
  const [name, listener, options] = state.listeners
  assert.equal(name, 'agent/pre-step')
  assert.equal(options.prepend, true, 'it must wrap the listener that adds them')
  const messages = [{ source: { kind: 'memories' } }, { source: { kind: 'agent-instructions' } }, { source: { kind: 'runtime-context' } }]
  const entered = await listener({}, async () => ({ kind: 'enter', messages }))
  assert.deepEqual(entered.messages.map((message) => message.source.kind), ['memories', 'runtime-context'])
  assert.deepEqual(await listener({}, async () => ({ kind: 'reject' })), { kind: 'reject' })
})

test('an effort the model lacks is dropped', async () => {
  const { ctx, state } = stubCtx({ efforts: [{ id: 'high' }] })
  await createDshConsolidationRunner(ctx).run(await request())
  assert.equal('reasoningEffort' in state.created.agentOptions, false)
})

test('a turn that ends badly is a failure', async () => {
  const { ctx } = stubCtx({ turnEnd: { kind: 'error', error: { message: 'no API key' } } })
  assert.deepEqual(await createDshConsolidationRunner(ctx).run(await request()), { status: 'failed', error: 'no API key' })
})

test('losing the job cancels the agent and still disposes it', async () => {
  const controller = new AbortController()
  const { ctx, state } = stubCtx({ idle: new Promise(() => {}) })
  const running = createDshConsolidationRunner(ctx).run(await request({ signal: controller.signal }))
  setTimeout(() => controller.abort(new Error('lost ownership')), 5)
  assert.deepEqual(await running, { status: 'failed', error: 'lost ownership' })
  assert.equal(state.cancelled.message, 'lost ownership')
  assert.equal(state.disposed, true)
})

test('a run that never finishes times out', async () => {
  const { ctx, state } = stubCtx({ idle: new Promise(() => {}) })
  const result = await createDshConsolidationRunner(ctx, { timeoutMs: 10 }).run(await request())
  assert.equal(result.status, 'failed')
  assert.equal(state.disposed, true)
})
