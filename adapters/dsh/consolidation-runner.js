// ConsolidationRunner over `ctx.agents` (D5, route A).
//
// Codex confines this agent with an OS sandbox. Here the agent inherits no tools
// at all and gets its own file tools whose confinement is in code, so isolation
// does not depend on the profile's presets. The workspace-write sandbox and the
// `never` approval policy remain as a second layer.

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'

import { consolidationToolDefinitions } from './consolidation-tools.js'
import { effectiveReasoningEffort } from './model-client.js'

export const DEFAULT_CONSOLIDATION_TIMEOUT_MS = 30 * 60 * 1000

/** Session replay rejects a message without an id and role, even though appending accepts it. */
function promptMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'memories' }),
  })
}

/** Removes AGENTS.md-style messages from what enters a step. */
export async function withoutWorkspaceInstructions(_payload, next) {
  const decision = await next()
  if (decision.kind !== 'enter') return decision
  return { ...decision, messages: decision.messages.filter((message) => message.source?.kind !== 'agent-instructions') }
}

function toSessionId(threadId) {
  return threadId.startsWith('dsh:') ? threadId.slice('dsh:'.length) : threadId
}

/**
 * @param {{agents: object, llm: object, approval?: object}} ctx
 * @param {{timeoutMs?: number}} [options]
 * @returns {import('../../core/ports.js').ConsolidationRunner}
 */
export function createDshConsolidationRunner(ctx, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONSOLIDATION_TIMEOUT_MS

  return {
    async run({ root, prompt, route, reasoningEffort, currentThreadId, signal }) {
      const canonicalRoot = await realpath(root)
      const roots = root === canonicalRoot ? [root] : [root, canonicalRoot]
      const effort = await effectiveReasoningEffort(ctx.llm, route, reasoningEffort, signal)
      const handle = await ctx.agents.create({
        sessionId: `session-${randomUUID()}`,
        // Subagent identity keeps this run out of the session list, title generation
        // and memory extraction, which is what Codex's ephemeral thread achieves.
        meta: { cwd: canonicalRoot, parentSession: toSessionId(currentThreadId), origin: 'subagent', delegationDepth: 1 },
        agentOptions: { provider: route.provider, model: route.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
        setup: (agentCtx, agent) => {
          agentCtx.tools.restrict({ allow: [] })
          for (const definition of consolidationToolDefinitions(roots)) agentCtx.tools.register(definition)
          agent.session.append('sandbox/mode', { mode: 'workspace-write' })
          // Global instructions are not evidence; left in, the agent writes them into memory.
          agentCtx.on('agent/pre-step', withoutWorkspaceInstructions, { prepend: true })
        },
      })
      try {
        ctx.approval?.setPolicy(handle.agent, 'never')
        handle.agent.followup(promptMessage(prompt))
        const outcome = await waitForIdle(handle.agent, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]))
        if (outcome !== undefined) return { status: 'failed', error: outcome }
        return finalStatus(handle.agent.session.snapshotEvents(0))
      } finally {
        await handle.dispose()
      }
    },
  }
}

/** @returns {Promise<string|undefined>} why the wait was cut short, if it was */
async function waitForIdle(agent, signal) {
  const interrupted = new Promise((resolvePromise) => {
    if (signal.aborted) resolvePromise(true)
    else signal.addEventListener('abort', () => resolvePromise(true), { once: true })
  })
  const idle = agent.whenIdle().then(() => false)
  if (!(await Promise.race([idle, interrupted]))) return undefined
  agent.cancel(signal.reason)
  return signal.reason instanceof Error ? signal.reason.message : 'consolidation was interrupted'
}

function finalStatus(events) {
  const reason = events.filter((event) => event.type === 'turn/end').at(-1)?.data.reason
  if (reason?.kind === 'completed') return { status: 'completed' }
  return { status: 'failed', error: reason?.error?.message ?? `consolidation turn ended with "${reason?.kind ?? 'no turn'}"` }
}
