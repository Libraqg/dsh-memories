// Shared test doubles. The in-memory source and model double as the second
// adapter that keeps the core's port boundary honest.

import { rmSync } from 'node:fs'
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoryStore, resolveMemoriesConfig, runMemoryPipeline } from '../../core/index.js'

/**
 * Timeout signals and the heartbeat timer are unref'd. On Node 22 the test
 * runner cancels a test whose only pending work is such a timer, so tests
 * that wait on one hold the event loop open until they finish.
 */
export function keepEventLoopAlive(t) {
  const handle = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(handle))
}

const tempDirs = new Set()

/**
 * A fresh directory under the OS temp folder, removed when the process exits.
 * `node --test` runs each file in its own process, so nothing outlives a test file.
 */
export async function makeTempDir(prefix) {
  if (tempDirs.size === 0) {
    process.once('exit', () => {
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    })
  }
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const CURRENT_THREAD = 'test:current'

/** 2026-11-08T12:00:00Z, the instant the fixture sessions are aged against. */
export const FIXTURE_NOW_MS = Date.UTC(2026, 10, 8, 12)
export const EXTRACT_ROUTE = { provider: 'test-api', model: 'small' }

const HOUR_MS = 3_600_000

export function fakeClock(startMs = FIXTURE_NOW_MS) {
  let now = startMs
  return { nowMs: () => now, advanceHours: (hours) => (now += hours * HOUR_MS) }
}

/** A scratch memory root seeded from fixtures/test-vault, so the fixture stays pristine. */
export async function tempMemoryRoot() {
  const base = await makeTempDir('memories-test-')
  const memoryRoot = join(base, 'memories')
  await cp(join(REPO_ROOT, 'fixtures/test-vault'), memoryRoot, { recursive: true })
  return { memoryRoot, stateDbPath: join(base, 'memories_state.sqlite') }
}

export function thread(name, overrides = {}) {
  return {
    id: `test:${name}`,
    rolloutPath: `test://${name}`,
    cwd: `/tmp/${name}`,
    createdAtMs: FIXTURE_NOW_MS - 72 * HOUR_MS,
    updatedAtMs: FIXTURE_NOW_MS - 24 * HOUR_MS,
    gitBranch: null,
    memoryMode: 'enabled',
    ...overrides,
  }
}

export function userItem(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
}

export function fakeSource(threads, items = () => [userItem('do the work')]) {
  return {
    threads,
    listThreads: async () => threads,
    readRollout: async (threadId) => items(threadId),
  }
}

export function memoryJson(slug, overrides = {}) {
  return JSON.stringify({ raw_memory: `raw for ${slug}`, rollout_summary: `# summary of ${slug}`, rollout_slug: slug, ...overrides })
}

/** Records every request; `respond` returns the model text or throws. */
export function fakeModel(respond = (request) => memoryJson(/rollout_path: (\S+)/.exec(request.input)?.[1].replace(/\W+/g, '-') ?? 'x')) {
  const model = {
    requests: [],
    availability: { ok: true },
    available: async () => model.availability,
    contextWindow: async () => 1_000_000,
    complete: async (request) => {
      model.requests.push(request)
      return { text: respond(request) }
    },
  }
  return model
}

export const WORKSPACE_DIFF = 'phase2_workspace_diff.md'

/** Stands in for the consolidation agent by writing valid artifacts. */
export async function writeValidArtifacts({ root }) {
  await writeFile(join(root, 'MEMORY.md'), '# Task Group: test\n')
  await writeFile(join(root, 'memory_summary.md'), 'v1\n## User Profile\n')
}

/** Records every request with the diff the agent would have read; `act` plays the agent. */
export function fakeRunner(act = writeValidArtifacts) {
  const runner = {
    act,
    requests: [],
    run: async (request) => {
      runner.requests.push({ ...request, diff: await readFile(join(request.root, WORKSPACE_DIFF), 'utf8') })
      return (await runner.act(request)) ?? { status: 'completed' }
    },
  }
  return runner
}

/** A wired-up core with test doubles behind every port. */
export async function pipelineHarness({ threads, items, respond, runnerAct, overrides, deps: extraDeps } = {}) {
  const paths = await tempMemoryRoot()
  const clock = fakeClock()
  const config = resolveMemoriesConfig({ ...paths, extractModel: EXTRACT_ROUTE, ...overrides })
  const deps = {
    config,
    clock,
    store: new MemoryStore(config.stateDbPath, clock),
    source: fakeSource(threads ?? [thread('a')], items),
    model: fakeModel(respond),
    runner: fakeRunner(runnerAct),
    ...extraDeps,
  }
  const run = () => runMemoryPipeline(deps, { currentThreadId: CURRENT_THREAD })
  return {
    deps,
    clock,
    run,
    /** Runs once the six-hour success cooldown has passed. */
    runAfterCooldown: () => {
      clock.advanceHours(7)
      return run()
    },
  }
}

/** A `ctx.sessionQuery` stand-in that reads the DSH-shaped fixture logs. */
export async function fixtureSessionQuery(directory = join(REPO_ROOT, 'fixtures/sessions')) {
  const sessions = new Map()
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.jsonl'))) {
    const [header, ...events] = (await readFile(join(directory, name), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    sessions.set(header.id, { header, events })
  }
  const query = {
    reads: 0,
    listSessions: async () => [...sessions.values()].map(({ header }) => ({ header, live: false, persisted: true })),
    readSession: async (id) => {
      query.reads += 1
      const session = sessions.get(id)
      if (session === undefined) throw new Error(`no session ${id}`)
      return { session: session.header, inheritedEventCount: session.header.inheritedEventCount ?? 0, events: session.events }
    },
  }
  return query
}
