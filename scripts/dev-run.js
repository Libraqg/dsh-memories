// Runs the memory pipeline end to end against the fixture sessions, through the
// real DSH session adapter, with a canned model and consolidation agent.
// Never touches a real vault.
//
//   node scripts/dev-run.js [--root <dir>]

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createDshSessionSource } from '../adapters/dsh/session-source.js'
import { MemoryStore, resolveMemoriesConfig, runMemoryPipeline } from '../core/index.js'
import { EXTRACT_ROUTE, fakeClock, fakeModel, fakeRunner, fixtureSessionQuery, memoryJson, tempMemoryRoot } from '../test/helpers/fakes.js'

const rootFlag = process.argv.indexOf('--root')
const paths = rootFlag === -1
  ? await tempMemoryRoot()
  : { memoryRoot: process.argv[rootFlag + 1], stateDbPath: join(process.argv[rootFlag + 1], '..', 'memories_state.sqlite') }

const clock = fakeClock()
const config = resolveMemoriesConfig({ ...paths, extractModel: EXTRACT_ROUTE })
const store = new MemoryStore(config.stateDbPath, clock)
const model = fakeModel((request) => {
  if (request.input.includes('hello there')) return '{"rollout_summary":"","rollout_slug":"","raw_memory":""}'
  return memoryJson('fix upload test')
})
const deps = {
  config,
  store,
  model,
  clock,
  runner: fakeRunner(),
  source: createDshSessionSource({ sessionQuery: await fixtureSessionQuery() }),
  logger: { info: (message) => console.log(`[info] ${message}`), warn: (message) => console.log(`[warn] ${message}`) },
}

console.log('first run: ', await runMemoryPipeline(deps, { currentThreadId: 'dsh:dev' }))
console.log('second run:', await runMemoryPipeline(deps, { currentThreadId: 'dsh:dev' }))
console.log(`\nmemory root: ${config.memoryRoot}`)
console.log(await readdir(config.memoryRoot))
console.log(await readdir(join(config.memoryRoot, 'rollout_summaries')))
console.log(`\n--- raw_memories.md\n${await readFile(join(config.memoryRoot, 'raw_memories.md'), 'utf8')}`)
console.log(`--- diff seen by the consolidation agent\n${deps.runner.requests[0]?.diff.slice(0, 400)}`)
store.close()
