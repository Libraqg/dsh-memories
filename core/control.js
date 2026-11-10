// Usage accounting and memory reset (codex-rs/memories/write/src/control.rs).

import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { tryAcquireWorkspaceLock } from './workspace-lock.js'

const ROLLOUT_SUMMARIES_PREFIX = 'rollout_summaries/'
const THREAD_ID_LINE = /^thread_id: (.+)$/m
const HEADER_READ_BYTES = 512

async function readThreadId(path) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return undefined
  }
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_READ_BYTES), 0, HEADER_READ_BYTES, 0)
    return THREAD_ID_LINE.exec(buffer.subarray(0, bytesRead).toString('utf8'))?.[1]
  } finally {
    await handle.close()
  }
}

/**
 * Counts one read of a rollout summary as one use of its stage-one output (D7).
 * @param {string} relativePath path relative to the memory root
 * @returns {Promise<boolean>} whether a stored output was credited
 */
export async function recordRolloutSummaryRead({ store, config }, relativePath) {
  if (!relativePath.startsWith(ROLLOUT_SUMMARIES_PREFIX) || !relativePath.endsWith('.md')) return false
  const threadId = await readThreadId(join(config.memoryRoot, relativePath))
  return threadId === undefined ? false : store.recordStage1OutputUsage([threadId]) > 0
}

/**
 * Forgets everything: files in the memory root and all pipeline state.
 * @returns {Promise<boolean>} false when a consolidation currently owns the workspace
 */
export async function clearMemories({ config, store, clock }) {
  const root = config.memoryRoot
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`refusing to clear symlinked memory root ${root}`)
  const lock = await tryAcquireWorkspaceLock(root, clock)
  if (lock === null) return false
  try {
    for (const name of await readdir(root)) await rm(join(root, name), { recursive: true, force: true })
    store.clearMemoryData()
    return true
  } finally {
    await lock.release()
  }
}
