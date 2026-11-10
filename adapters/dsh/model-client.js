// ModelClient over `ctx.llm`. A route is `{provider, model, reasoningEffort?}`,
// so API-key, account and subscription providers share this one path (D12).

import { ModelRouteUnavailableError } from '../../core/ports.js'

export const DEFAULT_MODEL_TIMEOUT_MS = 10 * 60 * 1000

/** Failure codes that describe the route rather than this request (D13). */
const ROUTE_UNAVAILABLE_CODES = new Set(['MISSING_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'MODEL_UNSUPPORTED'])

function providerIds(llm) {
  return (llm.listProviders() ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.id))
}

function timeoutSignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

function failureError(failure, route) {
  const label = `${route.provider}/${route.model}`
  const message = `model request to ${label} failed: ${failure?.message ?? 'unknown error'}`
  return ROUTE_UNAVAILABLE_CODES.has(failure?.code) ? new ModelRouteUnavailableError(message) : new Error(message)
}

/** An explicit route effort wins; the core's hint applies only where the model supports it. */
export async function effectiveReasoningEffort(llm, route, hint, signal) {
  if (route.reasoningEffort !== undefined) return route.reasoningEffort
  if (hint === undefined) return undefined
  const info = await llm.resolveModelInfo(route.provider, route.model, signal)
  return info.reasoning?.efforts?.some((effort) => effort.id === hint) ? hint : undefined
}

/**
 * @param {{llm: object}} ctx
 * @param {{timeoutMs?: number}} [options]
 * @returns {import('../../core/ports.js').ModelClient}
 */
export function createDshModelClient(ctx, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS

  async function modelInfo(route, signal) {
    return ctx.llm.resolveModelInfo(route.provider, route.model, signal)
  }

  return {
    async available(route, signal) {
      if (!providerIds(ctx.llm).includes(route.provider)) {
        return { ok: false, reason: `provider "${route.provider}" is not registered` }
      }
      try {
        await modelInfo(route, signal)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },

    async contextWindow(route, signal) {
      return (await modelInfo(route, signal)).context?.contextWindow
    },

    async complete({ route, system, input, reasoningEffort, signal }) {
      const effort = await effectiveReasoningEffort(ctx.llm, route, reasoningEffort, signal)
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        signal: timeoutSignal(signal, timeoutMs),
      })
      let text = ''
      let finish
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason
      }
      if (finish?.kind !== 'stop') {
        if (finish?.kind === 'error' || finish?.kind === 'aborted') throw failureError(finish.failure, route)
        throw new Error(`model request to ${route.provider}/${route.model} ended with "${finish?.kind ?? 'no finish'}"`)
      }
      return { text }
    },
  }
}
