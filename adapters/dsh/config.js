// Resolves the plugin's row configuration into the core's configuration.

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createExternalKnowledgePolicy, resolveMemoriesConfig } from '../../core/index.js'

/** API by default; any registered provider, including subscriptions, may be configured. */
export const DEFAULT_EXTRACT_MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' })
export const DEFAULT_CONSOLIDATION_MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })

function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? configured : join(homedir(), '.dsh')
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function route(value, fallback) {
  const provider = nonEmpty(value?.provider)
  const model = nonEmpty(value?.model)
  if (provider === undefined || model === undefined) return fallback
  const reasoningEffort = nonEmpty(value?.reasoningEffort)
  return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort }
}

function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/**
 * The knowledge base kept out of generated memory, if one is configured.
 * Reading `sessionExcludedPaths` removes the whole session; reading anything
 * else only removes that content. Without `externalKnowledge.root` nothing is filtered.
 */
export function resolveExternalKnowledgePolicy(raw = {}) {
  const root = nonEmpty(raw.externalKnowledge?.root)
  if (root === undefined) return undefined
  return createExternalKnowledgePolicy({
    root: expandHome(root),
    sessionExcludedPaths: raw.externalKnowledge?.sessionExcludedPaths ?? [],
  })
}

export function resolveDshConfig(raw = {}) {
  return resolveMemoriesConfig({
    ...raw,
    memoryRoot: nonEmpty(raw.memoryRoot) ?? join(dshHome(), 'memories'),
    stateDbPath: nonEmpty(raw.stateDbPath),
    extractModel: route(raw.extractModel, DEFAULT_EXTRACT_MODEL),
    consolidationModel: route(raw.consolidationModel, DEFAULT_CONSOLIDATION_MODEL),
  })
}
