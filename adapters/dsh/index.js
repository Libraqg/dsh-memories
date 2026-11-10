// DSH host plugin: wires the harness hooks to the memory core. Everything that
// decides what to remember lives in the core.

import { isAbsolute, relative, sep } from 'node:path'
import { mkdirSync, realpathSync } from 'node:fs'

import {
  LocalMemoriesBackend,
  MemoryStore,
  buildMemoryReadInstructions,
  recordRolloutSummaryRead,
  runMemoryPipeline,
} from '../../core/index.js'
import { memoriesCommand } from './commands.js'
import { resolveDshConfig, resolveExternalKnowledgePolicy } from './config.js'
import { Config, readConfigSnapshot } from './config-schema.js'
import { createDshConsolidationRunner } from './consolidation-runner.js'
import { createDshModelClient } from './model-client.js'
import { createDshSessionSource } from './session-source.js'
import { memoryToolDefinitions } from './tools.js'

/** After first-party guidance, before the deployment persona suffix. */
const READ_PATH_SECTION_ORDER = 9_500

const CONVERSATION_EVENTS = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

function isRootSession(header) {
  return (header.delegationDepth ?? 0) === 0 && header.parentSession === undefined
}

function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The memory-relative path a tool call reads, or undefined when it reads something else. */
export function memoryReadPath(roots, name, rawArguments) {
  let args
  try {
    args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments
  } catch {
    return undefined
  }
  if (name === 'memories_read') return typeof args?.path === 'string' ? args.path : undefined
  if (name !== 'read' || typeof args?.file_path !== 'string' || !isAbsolute(args.file_path)) return undefined
  for (const root of roots) {
    const path = relative(root, args.file_path)
    if (path !== '' && !path.startsWith('..')) return path.split(sep).join('/')
  }
  return undefined
}

export { Config }
export const name = 'memories'
export const inject = ['llm', 'agents', 'approval', 'sessionQuery', 'tools', 'commands', 'systemPrompt']

export function apply(ctx, rawConfig) {
  // Model routes are volatile: each pipeline run and command reads the current value.
  const currentConfig = () => resolveDshConfig(readConfigSnapshot(rawConfig))
  const config = currentConfig()
  // Without the folder the memory tools report errors, which models then memorize as lessons.
  mkdirSync(config.memoryRoot, { recursive: true })
  const logger = {
    info: (message) => ctx.logger?.info?.(`memories: ${message}`),
    warn: (message) => ctx.logger?.warn?.(`memories: ${message}`),
  }
  const store = new MemoryStore(config.stateDbPath, { nowMs: () => Date.now() })
  const source = createDshSessionSource(ctx, { externalKnowledge: resolveExternalKnowledgePolicy(readConfigSnapshot(rawConfig)) })
  const deps = {
    get config() {
      return currentConfig()
    },
    store,
    source,
    logger,
    model: createDshModelClient(ctx),
    runner: createDshConsolidationRunner(ctx),
  }
  const shutdown = new AbortController()
  let inflight

  function isConsolidationSession(header) {
    return header.origin === 'subagent' && header.cwd === canonical(config.memoryRoot)
  }

  /** One background pass at a time; a turn that arrives meanwhile adds nothing. */
  function startPipeline(session) {
    if (inflight !== undefined || !config.generateMemories || shutdown.signal.aborted) return
    inflight = ctx.agents
      .withoutInitiator(() => runMemoryPipeline(deps, { currentThreadId: `dsh:${session.id}`, signal: shutdown.signal }))
      .catch((error) => logger.warn(`pipeline failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        inflight = undefined
      })
  }

  // A read counts once per turn, however many times the agent re-opens the file.
  const creditedThisTurn = new Map()

  function creditRead(session, event) {
    const path = memoryReadPath([config.memoryRoot, canonical(config.memoryRoot)], event.data.name, event.data.arguments)
    if (path === undefined) return
    const credited = creditedThisTurn.get(session.id) ?? new Set()
    if (credited.has(path)) return
    credited.add(path)
    creditedThisTurn.set(session.id, credited)
    recordRolloutSummaryRead(deps, path).catch((error) => logger.warn(`usage update failed: ${error.message}`))
  }

  ctx.on('session/event', (session, event) => {
    if (isConsolidationSession(session.header)) return
    if (CONVERSATION_EVENTS.has(event.type)) source.markDirty(session.id)
    if (event.type === 'tool/call') creditRead(session, event)
    if (event.type === 'turn/start') {
      creditedThisTurn.delete(session.id)
      if (isRootSession(session.header)) startPipeline(session)
    }
  })

  ctx.on('session/disposed', (session) => creditedThisTurn.delete(session.id))

  ctx.on('agent/created', async ({ agent }) => {
    if (!config.useMemories || isConsolidationSession(agent.session.header)) return
    // Read once and frozen, so a background consolidation cannot change a live prompt.
    const text = await buildMemoryReadInstructions(config.memoryRoot)
    if (text !== undefined) {
      agent.ctx.systemPrompt.section({ name: 'memories:read-path', order: READ_PATH_SECTION_ORDER, interpolate: false, text })
    }
  })

  if (config.useMemories) {
    const backend = new LocalMemoriesBackend(config.memoryRoot)
    for (const definition of memoryToolDefinitions(backend)) ctx.tools.register(definition)
  }
  ctx.effect(() => ctx.commands.register(memoriesCommand(ctx, deps)), 'memories.command')

  ctx.effect(
    () => () => {
      shutdown.abort(new Error('memories plugin stopped'))
      Promise.resolve(inflight).finally(() => store.close())
    },
    'memories.lifecycle',
  )
}
