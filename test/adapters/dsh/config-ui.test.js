import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

import { Config, readConfigSnapshot } from '../../../adapters/dsh/config-schema.js'
import { resolveDshConfig } from '../../../adapters/dsh/config.js'
import { REPO_ROOT } from '../../helpers/fakes.js'

test('the Config accepts an empty row and every field the plugin reads', () => {
  assert.doesNotThrow(() => Config({}))
  const value = Config({
    memoryRoot: '/m',
    extractModel: { provider: 'claude', model: 'haiku', reasoningEffort: 'low' },
    consolidationModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    externalKnowledge: false,
    minRolloutIdleHours: 6,
  })
  assert.deepEqual(readConfigSnapshot(value).extractModel, { provider: 'claude', model: 'haiku', reasoningEffort: 'low' })
  assert.equal(readConfigSnapshot(value).externalKnowledge, false)
  assert.doesNotThrow(() => Config({ externalKnowledge: { root: '/v', sessionExcludedPaths: ['personal'] } }))
})

test('model routes are volatile and resolve to the defaults when unset', () => {
  const value = Config({})
  assert.equal(typeof value.extractModel.get, 'function', 'the Plugins page may edit it in place')
  const config = resolveDshConfig(readConfigSnapshot(value))
  assert.deepEqual(config.extractModel, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(config.consolidationModel, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
})

test('a changed volatile route is seen on the next read', () => {
  let route = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const raw = { extractModel: { get: () => route } }
  assert.equal(resolveDshConfig(readConfigSnapshot(raw)).extractModel.model, 'deepseek-flash')
  route = { provider: 'claude', model: 'claude-haiku-5-5' }
  assert.equal(resolveDshConfig(readConfigSnapshot(raw)).extractModel.provider, 'claude')
})

/**
 * Loads client.js the way DSH's module loader does, with a React stand-in whose
 * hooks keep their state by call order across renders, like React itself.
 */
async function loadClient() {
  const source = await readFile(join(REPO_ROOT, 'client.js'), 'utf8')
  let loaded
  const hooks = { slots: [], index: 0 }
  const slot = (init) => {
    const index = hooks.index++
    if (!(index in hooks.slots)) hooks.slots[index] = init()
    return index
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: (initial) => {
      const index = slot(() => (typeof initial === 'function' ? initial() : initial))
      return [hooks.slots[index], (next) => { hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next }]
    },
    useEffect: (effect, deps) => {
      const index = slot(() => ({ deps: undefined }))
      const previous = hooks.slots[index].deps
      if (previous === undefined || deps.some((dep, i) => dep !== previous[i])) {
        hooks.slots[index].deps = deps
        effect()
      }
    },
  }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (definition) => { loaded = definition } } } })
  const beginRender = () => { hooks.index = 0 }
  return { module: loaded.factory((name) => (name === 'react' ? React : undefined)), id: loaded.id, beginRender }
}

function render(node) {
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}

function texts(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (node && typeof node === 'object') node.children.forEach((child) => texts(child, out))
  return out
}

function find(node, predicate, out = []) {
  if (node && typeof node === 'object') {
    if (predicate(node)) out.push(node)
    node.children.forEach((child) => find(child, predicate, out))
  }
  return out
}

function fakeHost(value) {
  const registered = []
  const mutations = []
  let snapshot = { status: 'ready', writable: true, revision: 1, value }
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    mutate: async (operations, revision) => {
      mutations.push({ operations, revision })
      const next = { ...snapshot.value }
      for (const operation of operations) {
        if (operation.op === 'set') next[operation.path[0]] = operation.value
        else delete next[operation.path[0]]
      }
      snapshot = { ...snapshot, revision: snapshot.revision + 1, value: next }
    },
  }
  const ctx = {
    effect: (body) => body(),
    locale: { register: () => () => {} },
    configForms: { get: (id) => (id === 'memories' ? scope : undefined), whileServed: (ids, register) => (assert.deepEqual([...ids], ['memories']), register()) },
    slots: { inject: (_name, body) => body(), register: (options, component) => registered.push({ options, component }) },
    remote: {
      session: {
        modelCatalog: async () => ({
          ok: true,
          value: { failures: [], groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] }, { id: 'claude', name: 'Claude', models: [{ id: 'claude-haiku-5-5', name: 'Haiku' }] }] },
        }),
      },
    },
  }
  return { ctx, registered, mutations, scope }
}

const t = (key) => key

test('the client registers one configuration page for this row', async () => {
  const { module, id } = await loadClient()
  assert.equal(id, '@libraqg/dsh-memories')
  assert.deepEqual([...module.inject], ['slots', 'locale', 'remote', 'remote.session', 'configForms'])
  const host = fakeHost({})
  module.apply(host.ctx)
  assert.equal(host.registered.length, 1)
  assert.deepEqual({ ...host.registered[0].options }, { name: 'plugins.row.config', key: '@libraqg/dsh-memories#memories', locale: 'libraqgMemories' })
})

test('the summary names both routes, or the default', async () => {
  const { module } = await loadClient()
  const host = fakeHost({ extractModel: { provider: 'claude', model: 'claude-haiku-5-5' }, consolidationModel: {} })
  module.apply(host.ctx)
  const summary = render(host.registered[0].component({ t: (key) => (key === 'summary' ? '{extract} | {consolidation}' : key), view: 'summary' }))
  assert.equal(summary, 'claude / claude-haiku-5-5 | defaultModel')
})

test('the page offers the default, the catalog, and a stored route that is no longer listed', async () => {
  const { module } = await loadClient()
  const host = fakeHost({ extractModel: { provider: 'gone', model: 'old' } })
  module.apply(host.ctx)
  const page = render(host.registered[0].component({ t, view: 'page' }))
  const selects = find(page, (node) => node.type === 'select')
  assert.equal(selects.length, 2)
  const options = find(selects[0], (node) => node.type === 'option').map((node) => node.props.value)
  assert.equal(options[0], '', 'the default comes first')
  assert.ok(options.includes(JSON.stringify(['gone', 'old'])), 'a stored route survives even when the catalog lacks it')
  assert.equal(selects[0].props.value, JSON.stringify(['gone', 'old']))
  assert.equal(selects[1].props.value, '')
  assert.ok(texts(page).includes('note'))
})

test('saving writes only the changed field through the form, with the read revision', async () => {
  const { module, beginRender } = await loadClient()
  const host = fakeHost({ extractModel: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  module.apply(host.ctx)
  const draw = () => {
    beginRender()
    return render(host.registered[0].component({ t, view: 'page' }))
  }
  draw()
  await new Promise((resolve) => setImmediate(resolve))
  let page = draw()
  const optionValues = find(find(page, (node) => node.type === 'select')[1], (node) => node.type === 'option').map((node) => node.props.value)
  assert.ok(optionValues.includes(JSON.stringify(['claude', 'claude-haiku-5-5'])), 'the live catalog fills the list')

  find(page, (node) => node.type === 'select')[1].props.onChange({ target: { value: JSON.stringify(['claude', 'claude-haiku-5-5']) } })
  page = draw()
  const save = find(page, (node) => node.type === 'button' && node.children.includes('save'))[0]
  assert.equal(save.props.disabled, false)
  await save.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(host.mutations)), [{ operations: [{ op: 'set', path: ['consolidationModel'], value: { provider: 'claude', model: 'claude-haiku-5-5' } }], revision: 1 }])
  page = draw()
  assert.ok(texts(page).includes('saved'))
  assert.equal(find(page, (node) => node.type === 'button' && node.children.includes('save'))[0].props.disabled, true)

  find(page, (node) => node.type === 'select')[0].props.onChange({ target: { value: '' } })
  page = draw()
  await find(page, (node) => node.type === 'button' && node.children.includes('save'))[0].props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(host.mutations[1])), { operations: [{ op: 'unset', path: ['extractModel'] }], revision: 2 }, 'choosing the default removes the override')
})

test('a read-only configuration disables the controls', async () => {
  const { module, beginRender } = await loadClient()
  const host = fakeHost({})
  host.scope.getSnapshot = () => ({ status: 'ready', writable: false, revision: 1, value: {} })
  module.apply(host.ctx)
  beginRender()
  const page = render(host.registered[0].component({ t, view: 'page' }))
  assert.ok(find(page, (node) => node.type === 'select').every((node) => node.props.disabled))
  assert.ok(texts(page).includes('readOnly'))
})
