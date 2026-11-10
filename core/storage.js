// Port of codex-rs/memories/write/src/storage.rs and the layout helpers in lib.rs.

import { lstat, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROLLOUT_SUMMARIES_SUBDIR = 'rollout_summaries'
const RAW_MEMORIES_FILENAME = 'raw_memories.md'
const ROLLOUT_SLUG_MAX_LEN = 60
const SHORT_HASH_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const SHORT_HASH_SPACE = 14_776_336

export function rolloutSummariesDir(root) {
  return join(root, ROLLOUT_SUMMARIES_SUBDIR)
}

export function rawMemoriesFile(root) {
  return join(root, RAW_MEMORIES_FILENAME)
}

/** Removes every symbolic link below `root` without following any. Returns how many were removed. */
export async function removeMemorySymlinks(root) {
  let removed = 0
  const directories = [root]
  while (directories.length > 0) {
    const directory = directories.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        await unlink(path)
        removed += 1
      } else if (entry.isDirectory()) {
        directories.push(path)
      }
    }
  }
  return removed
}

/** Creates the memory layout, refusing a symlinked root and dropping symlinks inside it. */
export async function ensureLayout(root) {
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink()) {
    throw new Error(`memory root cannot be a symbolic link: ${root}`)
  }
  await removeMemorySymlinks(root)
  await mkdir(rolloutSummariesDir(root), { recursive: true })
}

/** Matches chrono's `to_rfc3339` for a whole-second UTC instant. */
function toRfc3339(seconds) {
  return new Date(seconds * 1000).toISOString().replace('.000Z', '+00:00')
}

function shortHash(threadId) {
  let seed = 0
  for (const byte of Buffer.from(threadId, 'utf8')) {
    seed = (Math.imul(seed, 31) + byte) >>> 0
  }
  let value = seed % SHORT_HASH_SPACE
  const characters = Array.from({ length: 4 }, () => '0')
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    characters[index] = SHORT_HASH_ALPHABET[value % SHORT_HASH_ALPHABET.length]
    value = Math.floor(value / SHORT_HASH_ALPHABET.length)
  }
  return characters.join('')
}

/**
 * Stem of a thread's summary file. Uses the thread's creation time rather than
 * its update time so the name is stable across updates (D9).
 */
export function rolloutSummaryFileStem(memory) {
  const timestamp = new Date(memory.createdAtMs).toISOString().slice(0, 19).replaceAll(':', '-')
  const prefix = `${timestamp}-${shortHash(memory.threadId)}`
  if (memory.rolloutSlug === null || memory.rolloutSlug === undefined) return prefix
  let slug = ''
  for (const character of memory.rolloutSlug) {
    if (slug.length >= ROLLOUT_SLUG_MAX_LEN) break
    slug += /^[A-Za-z0-9]$/.test(character) ? character.toLowerCase() : '_'
  }
  slug = slug.replace(/_+$/, '')
  return slug.length === 0 ? prefix : `${prefix}-${slug}`
}

/** Rewrites `raw_memories.md` from the selected stage-one outputs. */
export async function rebuildRawMemoriesFile(root, memories) {
  await ensureLayout(root)
  let body = '# Raw Memories\n\n'
  if (memories.length === 0) {
    await writeFile(rawMemoriesFile(root), `${body}No raw memories yet.\n`)
    return
  }
  body += 'Merged stage-1 raw memories (stable ascending thread-id order):\n\n'
  for (const memory of memories) {
    body += `## Thread \`${memory.threadId}\`\n`
    body += `updated_at: ${toRfc3339(memory.sourceUpdatedAt)}\n`
    body += `cwd: ${memory.cwd}\n`
    body += `rollout_path: ${memory.rolloutPath}\n`
    body += `rollout_summary_file: ${rolloutSummaryFileStem(memory)}.md\n\n`
    body += `${memory.rawMemory.trim()}\n\n`
  }
  await writeFile(rawMemoriesFile(root), body)
}

async function writeRolloutSummary(root, memory) {
  let body = `thread_id: ${memory.threadId}\n`
  body += `updated_at: ${toRfc3339(memory.sourceUpdatedAt)}\n`
  body += `rollout_path: ${memory.rolloutPath}\n`
  body += `cwd: ${memory.cwd}\n`
  if (memory.gitBranch !== null && memory.gitBranch !== undefined) body += `git_branch: ${memory.gitBranch}\n`
  body += `\n${memory.rolloutSummary}\n`
  await writeFile(join(rolloutSummariesDir(root), `${rolloutSummaryFileStem(memory)}.md`), body)
}

/** Makes `rollout_summaries/` hold exactly the selected outputs; pruning is what drives forgetting. */
export async function syncRolloutSummaries(root, memories) {
  await ensureLayout(root)
  const keep = new Set(memories.map(rolloutSummaryFileStem))
  for (const name of await readdir(rolloutSummariesDir(root))) {
    if (name.endsWith('.md') && !keep.has(name.slice(0, -3))) {
      await rm(join(rolloutSummariesDir(root), name), { force: true })
    }
  }
  for (const memory of memories) await writeRolloutSummary(root, memory)
}
