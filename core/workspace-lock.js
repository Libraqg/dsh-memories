// Replaces the OS file lock of codex-rs/memories/write/src/workspace_lock.rs,
// which Node cannot take (D10). The lock file lives beside the memory root so a
// baseline reset can never replace it. The database lease remains the main guard.

import { open, readFile, rm } from 'node:fs/promises'

const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function isStale(path, nowMs) {
  let owner
  try {
    owner = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return true
  }
  if (!Number.isInteger(owner?.pid) || !Number.isFinite(owner?.at)) return true
  return !processIsAlive(owner.pid) || nowMs - owner.at > MAX_LOCK_AGE_MS
}

async function create(path, nowMs) {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowMs }))
  } finally {
    await handle.close()
  }
}

/**
 * Takes exclusive ownership of a memory workspace.
 * @returns {Promise<{release:()=>Promise<void>}|null>} null when another owner holds it
 */
export async function tryAcquireWorkspaceLock(memoryRoot, clock) {
  const path = `${memoryRoot}.lock`
  const release = () => rm(path, { force: true })
  try {
    await create(path, clock.nowMs())
    return { release }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  if (!(await isStale(path, clock.nowMs()))) return null
  await rm(path, { force: true })
  try {
    await create(path, clock.nowMs())
    return { release }
  } catch (error) {
    if (error.code === 'EEXIST') return null
    throw error
  }
}
