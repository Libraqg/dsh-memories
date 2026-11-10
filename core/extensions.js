// Port of codex-rs/memories/write/src/extensions: the ad-hoc notes seed and the
// retention sweep whose deletions surface in the workspace diff as forgetting.

import { copyFile, constants, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RETENTION_DAYS = 14
const MS_PER_DAY = 86_400_000
const RESOURCE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/

export function memoryExtensionsRoot(root) {
  return join(root, 'extensions')
}

/** Creates the ad-hoc instructions once; a user's edits to that file are kept. */
export async function seedExtensionInstructions(root) {
  const directory = join(memoryExtensionsRoot(root), 'ad_hoc')
  await mkdir(directory, { recursive: true })
  const source = fileURLToPath(new URL('./templates/extensions/ad_hoc/instructions.md', import.meta.url))
  try {
    await copyFile(source, join(directory, 'instructions.md'), constants.COPYFILE_EXCL)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

function resourceTimestamp(name) {
  const match = RESOURCE_TIMESTAMP.exec(name)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second] = match.map(Number)
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

async function directoryEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Deletes timestamped extension resources past retention. */
export async function pruneOldExtensionResources(root, nowMs) {
  const cutoff = nowMs - RETENTION_DAYS * MS_PER_DAY
  const extensions = memoryExtensionsRoot(root)
  for (const extension of await directoryEntries(extensions)) {
    if (!extension.isDirectory()) continue
    const path = join(extensions, extension.name)
    if (!(await exists(join(path, 'instructions.md')))) continue
    const resources = join(path, 'resources')
    for (const resource of await directoryEntries(resources)) {
      if (!resource.isFile() || !resource.name.endsWith('.md')) continue
      const timestamp = resourceTimestamp(resource.name)
      if (timestamp !== undefined && timestamp <= cutoff) await rm(join(resources, resource.name), { force: true })
    }
  }
}
