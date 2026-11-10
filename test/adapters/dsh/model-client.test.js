import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDshModelClient } from '../../../adapters/dsh/model-client.js'
import { ModelRouteUnavailableError } from '../../../core/ports.js'

const ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' }

function stubLlm({ chunks = [{ type: 'text-delta', text: 'he' }, { type: 'text-delta', text: 'llo' }, { type: 'finish', reason: { kind: 'stop' } }], info = { context: { contextWindow: 1000 } }, stream } = {}) {
  const llm = {
    calls: [],
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'claude' }],
    resolveModelInfo: async () => {
      if (info instanceof Error) throw info
      return info
    },
    stream: stream ?? async function* (options) {
      llm.calls.push(options)
      yield* chunks
    },
  }
  return llm
}

const request = (extra = {}) => ({ route: ROUTE, system: 'sys', input: 'in', ...extra })

test('assembles text and forwards the route', async () => {
  const llm = stubLlm()
  const { text } = await createDshModelClient({ llm }).complete(request())
  assert.equal(text, 'hello')
  assert.equal(llm.calls[0].provider, 'deepseek-official')
  assert.equal(llm.calls[0].model, 'deepseek-flash')
  assert.equal(llm.calls[0].system, 'sys')
  assert.deepEqual(llm.calls[0].messages, [{ role: 'user', content: [{ type: 'text', text: 'in' }] }])
})

test('a subscription provider uses the same path', async () => {
  const llm = stubLlm()
  await createDshModelClient({ llm }).complete(request({ route: { provider: 'claude', model: 'haiku' } }))
  assert.equal(llm.calls[0].provider, 'claude')
})

test('the effort hint is sent only when the model supports it', async () => {
  const supported = stubLlm({ info: { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } } })
  await createDshModelClient({ llm: supported }).complete(request({ reasoningEffort: 'low' }))
  assert.equal(supported.calls[0].reasoningEffort, 'low')

  const unsupported = stubLlm({ info: {} })
  await createDshModelClient({ llm: unsupported }).complete(request({ reasoningEffort: 'low' }))
  assert.equal('reasoningEffort' in unsupported.calls[0], false)

  const explicit = stubLlm({ info: {} })
  await createDshModelClient({ llm: explicit }).complete(request({ route: { ...ROUTE, reasoningEffort: 'off' }, reasoningEffort: 'low' }))
  assert.equal(explicit.calls[0].reasoningEffort, 'off')
})

test('credential failures are route failures, other failures are job failures', async () => {
  const finish = (failure) => stubLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure } }] })
  await assert.rejects(createDshModelClient({ llm: finish({ code: 'MISSING_CREDENTIAL', message: 'no key' }) }).complete(request()), ModelRouteUnavailableError)
  await assert.rejects(
    createDshModelClient({ llm: finish({ code: 'RATE_LIMIT', message: 'slow down' }) }).complete(request()),
    (error) => !(error instanceof ModelRouteUnavailableError) && /slow down/.test(error.message),
  )
})

test('an output-capped response is a failure, not a partial memory', async () => {
  const llm = stubLlm({ chunks: [{ type: 'text-delta', text: '{"raw' }, { type: 'finish', reason: { kind: 'max-tokens' } }] })
  await assert.rejects(createDshModelClient({ llm }).complete(request()), /max-tokens/)
})

test('calls time out, so a closed subscription window cannot hang a job', async () => {
  const llm = stubLlm({
    stream: async function* (options) {
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted' } } }
    },
  })
  await assert.rejects(createDshModelClient({ llm }, { timeoutMs: 20 }).complete(request()), /aborted/)
})

test('availability reports unknown providers and unresolvable models', async () => {
  const client = createDshModelClient({ llm: stubLlm() })
  assert.deepEqual(await client.available(ROUTE), { ok: true })
  assert.equal((await client.available({ provider: 'nope', model: 'x' })).ok, false)
  const broken = createDshModelClient({ llm: stubLlm({ info: new Error('unknown model') }) })
  assert.deepEqual(await broken.available(ROUTE), { ok: false, reason: 'unknown model' })
})

test('context window comes from the resolved model', async () => {
  assert.equal(await createDshModelClient({ llm: stubLlm() }).contextWindow(ROUTE), 1000)
})
