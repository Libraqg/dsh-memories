// SessionSource over `ctx.sessionQuery`: maps the DSH session log to the
// harness-neutral rollout shape (D2) and derives thread facts from it (D3).

const THREAD_PREFIX = 'dsh:'

/**
 * User-role messages the harness injected, excluded for the same reasons Codex
 * excludes AGENTS.md blocks, skill bodies, configuration updates and compaction.
 * Other injected context (runtime-context, time-context) stays, as Codex keeps
 * `<environment_context>`.
 */
const EXCLUDED_USER_SOURCE_KINDS = new Set([
  'agent-instructions',
  'skill-catalog',
  'model-selection',
  'compact-checkpoint',
  'workspace-memory',
  'memories',
])

const CONVERSATION_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])
const WORKING_DIRECTORY_TOOL = 'working_directory'

function toThreadId(sessionId) {
  return `${THREAD_PREFIX}${sessionId}`
}

function toSessionId(threadId) {
  return threadId.startsWith(THREAD_PREFIX) ? threadId.slice(THREAD_PREFIX.length) : threadId
}

function isRootSession(header) {
  return (header.delegationDepth ?? 0) === 0 && header.parentSession === undefined && header.origin !== 'memories'
}

function textParts(content, type) {
  const parts = []
  for (const block of content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push({ type, text: block.text })
    else if (block.type === 'image') parts.push({ type, text: '[image omitted]' })
  }
  return parts
}

function plainText(content) {
  return textParts(content, 'output_text')
    .map((part) => part.text)
    .join('\n')
}

function argumentsText(rawArguments) {
  return typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {})
}

/**
 * Finds what this session took from the external knowledge base (D15).
 * @returns {{excludesSession:boolean, omitted:Map<string, Set<string>>}} tool call ids to the paths they touched
 */
function analyzeExternalKnowledge(events, header, policy) {
  const result = { excludesSession: false, omitted: new Map() }
  if (policy === undefined) return result
  // The consolidation agent handles memory text, which is not a use of the knowledge base.
  if (events.some((event) => event.type === 'user/message' && event.data.source?.kind === 'memories')) return result

  let location = policy.locate(header.cwd)
  result.excludesSession = location.excludesSession
  const toolNames = new Map()
  const omit = (callId, paths) => {
    const existing = result.omitted.get(callId) ?? new Set()
    for (const path of paths) existing.add(path)
    result.omitted.set(callId, existing)
  }
  const scanTool = (callId, text) => {
    const found = policy.scan(text)
    if (found.excludesSession || (location.inside && policy.mentionsExcludedRelative(text))) result.excludesSession = true
    if (found.paths.length > 0) omit(callId, found.paths)
    else if (location.inside) omit(callId, ['.'])
  }

  for (const event of events) {
    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      result.excludesSession ||= policy.scan(plainText(event.data.content)).excludesSession
    } else if (event.type === 'assistant/message') {
      result.excludesSession ||= policy.scan(plainText(event.data.message?.content)).excludesSession
    } else if (event.type === 'tool/call') {
      toolNames.set(event.data.callId, event.data.name)
      scanTool(event.data.callId, argumentsText(event.data.arguments))
    } else if (event.type === 'tool/result') {
      const callId = event.data.message?.toolCallId
      const text = plainText(event.data.message?.content)
      scanTool(callId, text)
      // Only this tool moves the session; `bash` starts a fresh shell for every call.
      if (toolNames.get(callId) === WORKING_DIRECTORY_TOOL && event.data.message?.isError !== true) {
        location = policy.locate(text)
        result.excludesSession ||= location.excludesSession
      }
    }
  }
  return result
}

/** Converts one conversational event; returns undefined for everything else. */
function eventToRolloutItem(event, omitted, policy) {
  switch (event.type) {
    case 'user/message': {
      if (EXCLUDED_USER_SOURCE_KINDS.has(event.data.source?.kind)) return undefined
      const content = textParts(event.data.content, 'input_text')
      return content.length === 0 ? undefined : { type: 'message', role: 'user', content }
    }
    case 'assistant/message': {
      // Reasoning is dropped as upstream drops it; tool calls come from `tool/call`.
      const content = textParts(event.data.message?.content, 'output_text')
      return content.length === 0 ? undefined : { type: 'message', role: 'assistant', content }
    }
    case 'tool/call': {
      const paths = omitted.get(event.data.callId)
      return {
        type: 'function_call',
        name: event.data.name,
        arguments: paths === undefined ? argumentsText(event.data.arguments) : JSON.stringify({ omitted: policy.placeholder(paths) }),
        call_id: event.data.callId,
      }
    }
    case 'tool/result': {
      const paths = omitted.get(event.data.message?.toolCallId)
      return {
        type: 'function_call_output',
        call_id: event.data.message?.toolCallId,
        output: {
          body: paths === undefined ? plainText(event.data.message?.content) : policy.placeholder(paths),
          success: event.data.message?.isError !== true,
        },
      }
    }
    default:
      return undefined
  }
}

/**
 * Events this session wrote itself, minus surface replacements: compaction
 * appends those beside the originals, and upstream never reads compaction output.
 */
function ownEvents(snapshot) {
  return snapshot.events.slice(snapshot.inheritedEventCount ?? 0).filter((event) => event.surfaceOp?.op !== 'replace')
}

/** Last conversational activity; bookkeeping events must not make a thread look updated. */
function summarize(snapshot, header, policy) {
  const events = ownEvents(snapshot)
  let updatedAtMs
  let hasUserMessage = false
  for (const event of events) {
    if (!CONVERSATION_EVENT_TYPES.has(event.type)) continue
    updatedAtMs = event.time
    if (event.type === 'user/message' && event.data.source?.kind === 'user') hasUserMessage = true
  }
  return { updatedAtMs, hasUserMessage, excludesSession: analyzeExternalKnowledge(events, header, policy).excludesSession }
}

function toThreadMeta(sessionId, header, summary, excluded) {
  return {
    id: toThreadId(sessionId),
    rolloutPath: `dsh://session/${sessionId}`,
    cwd: header.cwd ?? '',
    createdAtMs: header.createdAt,
    updatedAtMs: summary.updatedAtMs,
    gitBranch: null,
    memoryMode: excluded ? 'polluted' : 'enabled',
  }
}

/** Sessions that an excluding child reaches through its parent chain. */
function sessionsTaintedByChildren(records, summaries) {
  const parents = new Map(records.map(({ header }) => [header.id, header.parentSession]))
  const tainted = new Set()
  for (const { header } of records) {
    if (!summaries.get(header.id)?.excludesSession) continue
    const seen = new Set([header.id])
    let parent = parents.get(header.id)
    while (parent !== undefined && !seen.has(parent)) {
      tainted.add(parent)
      seen.add(parent)
      parent = parents.get(parent)
    }
  }
  return tainted
}

/**
 * @param {{sessionQuery: {listSessions: Function, readSession: Function}}} ctx
 * @param {{externalKnowledge?: ReturnType<import('../../core/external-knowledge.js').createExternalKnowledgePolicy>}} [options]
 * @returns {import('../../core/ports.js').SessionSource & {markDirty:(sessionId:string)=>void}}
 */
export function createDshSessionSource(ctx, options = {}) {
  const policy = options.externalKnowledge
  // `listSessions` has no update time, so each session is read once and cached.
  // A session/event listener calls markDirty; cold logs cannot change otherwise.
  const summaries = new Map()

  async function summaryFor(sessionId, header, signal) {
    const cached = summaries.get(sessionId)
    if (cached !== undefined) return cached
    const summary = summarize(await ctx.sessionQuery.readSession(sessionId, signal), header, policy)
    summaries.set(sessionId, summary)
    return summary
  }

  return {
    markDirty(sessionId) {
      summaries.delete(sessionId)
    },

    async listThreads(signal) {
      const records = await ctx.sessionQuery.listSessions(signal)
      // Children are read only when they can taint a parent.
      const relevant = records.filter(({ header }) => isRootSession(header) || (policy !== undefined && header.parentSession !== undefined))
      for (const record of relevant) await summaryFor(record.header.id, record.header, signal)
      const tainted = sessionsTaintedByChildren(relevant, summaries)

      const threads = []
      for (const { header } of relevant) {
        if (!isRootSession(header)) continue
        const summary = summaries.get(header.id)
        // Mirrors the upstream `preview <> ''` filter: nothing the user said, nothing to learn.
        if (summary.updatedAtMs === undefined || !summary.hasUserMessage) continue
        threads.push(toThreadMeta(header.id, header, summary, summary.excludesSession || tainted.has(header.id)))
      }
      return threads
    },

    async readRollout(threadId, signal) {
      const snapshot = await ctx.sessionQuery.readSession(toSessionId(threadId), signal)
      const events = ownEvents(snapshot)
      const { omitted } = analyzeExternalKnowledge(events, snapshot.session ?? {}, policy)
      return events.map((event) => eventToRolloutItem(event, omitted, policy)).filter((item) => item !== undefined)
    },
  }
}
