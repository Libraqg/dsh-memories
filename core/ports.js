/**
 * Harness-facing contract of the memory core.
 *
 * The core imports only `node:*` and its own modules. Everything specific to a
 * harness (session format, model transport, agent spawning) sits behind these
 * ports and is supplied by an adapter under `adapters/`.
 *
 * @typedef {object} ThreadMeta One conversation, as facts only; policy lives in the core.
 * @property {string} id Namespaced id, for example `dsh:session-…`.
 * @property {string} rolloutPath Locator shown to the memory prompts; may be a logical URI.
 * @property {string} cwd Working directory of the conversation.
 * @property {number} createdAtMs Stable creation time (names the rollout summary file).
 * @property {number} updatedAtMs Time of the last conversational event.
 * @property {string|null} gitBranch Branch when the harness records one.
 * @property {'enabled'|'polluted'|'disabled'} memoryMode Mirrors `threads.memory_mode`.
 *
 * @typedef {object} ContentItem
 * @property {'input_text'|'output_text'} type
 * @property {string} text
 *
 * @typedef {{type:'message', role:string, content:ContentItem[]}
 *   | {type:'function_call', name:string, arguments:string, call_id:string}
 *   | {type:'function_call_output', call_id:string, output:{body:string, success:boolean}}} RolloutItem
 * Harness-neutral subset of the Codex `ResponseItem` JSON.
 *
 * @typedef {object} SessionSource
 * @property {(signal?:AbortSignal)=>Promise<ThreadMeta[]>} listThreads
 *   Every root conversation the harness knows about, in any order.
 * @property {(threadId:string, signal?:AbortSignal)=>Promise<RolloutItem[]>} readRollout
 *   The conversation's own items, oldest first, with harness bookkeeping removed.
 *
 * @typedef {object} CompletionRequest
 * @property {unknown} route Opaque to the core; interpreted by the adapter.
 * @property {string} system
 * @property {string} input
 * @property {string} [reasoningEffort] A hint; the adapter drops it when unsupported.
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} ModelClient
 * @property {(route:unknown, signal?:AbortSignal)=>Promise<{ok:boolean, reason?:string}>} available
 * @property {(route:unknown, signal?:AbortSignal)=>Promise<number|undefined>} contextWindow
 * @property {(request:CompletionRequest)=>Promise<{text:string}>} complete
 *   Rejects with {@link ModelRouteUnavailableError} when the route cannot be
 *   used at all, so that the failure does not consume a job retry (D13).
 *
 * @typedef {object} ConsolidationRequest
 * @property {string} root Memory root; the agent's only writable location.
 * @property {string} prompt
 * @property {unknown} route Opaque to the core.
 * @property {string} [reasoningEffort] A hint; the adapter drops it when unsupported.
 * @property {string} currentThreadId The thread whose activity triggered this run.
 * @property {AbortSignal} signal Aborted when ownership of the job is lost.
 *
 * @typedef {object} ConsolidationRunner
 * @property {(request:ConsolidationRequest)=>Promise<{status:'completed'}|{status:'failed', error:string}>} run
 *   Runs one isolated agent to its end. It must have no network, no approvals,
 *   no recursion, and must be unable to write outside `root` or into `root/.git`.
 *
 * @typedef {object} Clock
 * @property {()=>number} nowMs
 *
 * @typedef {object} Logger
 * @property {(message:string)=>void} info
 * @property {(message:string)=>void} warn
 */

/** The configured route cannot serve requests: missing credential, signed out, unknown provider. */
export class ModelRouteUnavailableError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ModelRouteUnavailableError'
  }
}

/** @type {Clock} */
export const systemClock = { nowMs: () => Date.now() }

/** @type {Logger} */
export const silentLogger = { info() {}, warn() {} }
