// The row's Config. DSH validates the profile row against it, and its volatile
// fields are what the Plugins page form may edit; they change without a restart.
// schemastery is bundled because a linked plugin cannot resolve DSH's own copy.

import z from '@deepseek-ai/schemastery'

const Route = z.object({
  provider: z.string().description('Provider id, for example deepseek-official, deepseek-account or claude.'),
  model: z.string().description('Model id within that provider.'),
  reasoningEffort: z.string().description('Optional effort; omitted when the model does not support it.'),
})

export const Config = z.object({
  memoryRoot: z.string().description('Memory folder. Defaults to $DSH_HOME/memories.'),
  stateDbPath: z.string().description('State database. Defaults beside the memory folder.'),
  generateMemories: z.boolean().default(true),
  useMemories: z.boolean().default(true),
  extractModel: Route.description('Model that extracts memories from each conversation.').volatile(),
  consolidationModel: Route.description('Model that consolidates memories in the background.').volatile(),
  externalKnowledge: z.union([
    z.const(false),
    z.object({ root: z.string(), sessionExcludedPaths: z.array(z.string()) }),
  ]).description('Knowledge base kept out of memory; false turns the filter off.'),
  maxRawMemoriesForConsolidation: z.natural(),
  maxUnusedDays: z.natural(),
  maxRolloutAgeDays: z.natural(),
  maxRolloutsPerStartup: z.natural(),
  minRolloutIdleHours: z.natural(),
})

/** Volatile fields arrive as references; everything else as plain values. */
export function readConfigSnapshot(raw = {}) {
  const snapshot = {}
  for (const [key, value] of Object.entries(raw)) {
    const isReference = value !== null && typeof value === 'object' && typeof value.get === 'function' && Object.keys(value).length === 1
    snapshot[key] = isReference ? value.get() : value
  }
  return snapshot
}
