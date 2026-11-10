// The `/memories` command. Named apart from `/memory`, which the older
// workspace-memory plugin registers.

import { clearMemories, systemClock } from '../../core/index.js'

const USAGE = 'Usage: /memories [status|path|model list|model set <extract|consolidation> <provider> <model> [effort]|model clear <extract|consolidation>|reset --confirm]'
const CONFIG_KEYS = { extract: 'extractModel', consolidation: 'consolidationModel' }

function label(route) {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`}`
}

function formatTime(seconds) {
  return seconds === null ? 'never' : new Date(seconds * 1000).toISOString()
}

function statusText({ config, store }) {
  const { outputs, failedJobs, consolidation } = store.status()
  return [
    `Memory root: ${config.memoryRoot}`,
    `Extraction model: ${label(config.extractModel)}`,
    `Consolidation model: ${label(config.consolidationModel)}`,
    `Stored rollout memories: ${outputs}`,
    `Failed extraction jobs: ${failedJobs}`,
    consolidation === null
      ? 'Consolidation: not run yet'
      : `Consolidation: ${consolidation.status}, last finished ${formatTime(consolidation.finishedAt)}${consolidation.lastError ? `, last error: ${consolidation.lastError}` : ''}`,
  ].join('\n')
}

async function listModels(ctx) {
  const lines = []
  for (const { id } of ctx.llm.listProviders()) {
    let models
    try {
      models = await ctx.llm.listModels(id)
    } catch (error) {
      lines.push(`${id}: unavailable (${error.message})`)
      continue
    }
    lines.push(`${id}: ${models.length === 0 ? '(none listed)' : models.map((model) => model.id).join(', ')}`)
  }
  return lines.join('\n')
}

/** Persists through the config editor, the only supported way to change a plugin's row. */
async function saveRoute(ctx, stage, value) {
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (editor === undefined || entry === undefined) throw new Error('configuration cannot be saved in this profile')
  await editor.edit(entry, (current) => {
    const next = { ...current }
    if (value === undefined) delete next[CONFIG_KEYS[stage]]
    else next[CONFIG_KEYS[stage]] = value
    return next
  })
}

async function modelCommand(ctx, args) {
  const [action, stage, provider, model, effort] = args
  if (action === 'list') return { kind: 'success', text: `${await listModels(ctx)}\n` }
  if (!Object.hasOwn(CONFIG_KEYS, stage ?? '')) return { kind: 'error', text: USAGE }
  if (action === 'clear') {
    await saveRoute(ctx, stage, undefined)
    return { kind: 'success', text: `${stage} model restored to the default.\n` }
  }
  if (action !== 'set' || provider === undefined || model === undefined) return { kind: 'error', text: USAGE }
  if (!ctx.llm.listProviders().some((entry) => entry.id === provider)) {
    return { kind: 'error', text: `Provider "${provider}" is not registered. See /memories model list.` }
  }
  await saveRoute(ctx, stage, { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  return { kind: 'success', text: `${stage} model set to ${provider}/${model}.\n` }
}

/**
 * @param {object} ctx
 * @param {{config:object, store:object}} deps
 */
export function memoriesCommand(ctx, deps) {
  async function handle(args) {
    const [command, ...rest] = args
    if (command === undefined || command === 'status') return { kind: 'success', text: `${statusText(deps)}\n` }
    if (command === 'path') return { kind: 'success', text: `${deps.config.memoryRoot}\n` }
    if (command === 'model') return modelCommand(ctx, rest)
    if (command === 'reset') {
      if (!rest.includes('--confirm')) return { kind: 'error', text: "Add --confirm to delete every stored memory." }
      const cleared = await clearMemories({ clock: systemClock, ...deps })
      return cleared
        ? { kind: 'success', text: 'All memories deleted.\n' }
        : { kind: 'error', text: 'A consolidation is running. Try again when it finishes.' }
    }
    return { kind: 'error', text: USAGE }
  }

  return {
    name: 'memories',
    description: 'Long-term memory: status, model selection, reset.',
    input: { hint: '[status|path|model|reset --confirm]' },
    recordInput: false,
    handler: async ({ rawInput }) => {
      const text = String(rawInput ?? '').trim()
      try {
        return await handle(text.length === 0 ? [] : text.split(/\s+/u))
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
