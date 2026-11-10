// Port of codex-rs/git-utils/src/baseline.rs on top of the `git` binary (D11).
// `.git` here is a disposable diff implementation detail, never a user repository.

import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const MAX_BASELINE_FILE_BYTES = 10 * 1024 * 1024
const BASELINE_VERSION_FILE = 'memory-baseline-version'
const BASELINE_VERSION = '1\n'
const TEMPORARY_INDEX = '.git/memory-diff-index'
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024

/** Keeps the user's git configuration and hooks out of the baseline repository. */
const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.excludesFile=/dev/null',
  '-c', 'core.autocrlf=false',
  '-c', 'core.quotePath=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'user.name=memory-baseline',
  '-c', 'user.email=memory-baseline@localhost',
]

async function git(root, args, { env = {}, input } = {}) {
  const pending = run('git', [...GIT_CONFIG, ...args], {
    cwd: root,
    env: { ...GIT_ENV, ...env },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  })
  if (input !== undefined) pending.child.stdin.end(input)
  return (await pending).stdout
}

function versionFile(root) {
  return join(root, '.git', BASELINE_VERSION_FILE)
}

/** Files the baseline may contain, relative to root; oversized ones are reported separately. */
async function eligibleFiles(root) {
  const included = []
  const excluded = []
  const directories = [root]
  while (directories.length > 0) {
    const directory = directories.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(path)
      else if (entry.isFile()) {
        const name = relative(root, path).split(sep).join('/')
        const { size } = await lstat(path)
        ;(size <= MAX_BASELINE_FILE_BYTES ? included : excluded).push(name)
      }
    }
  }
  return { included: included.sort(), excluded: excluded.sort() }
}

function pathList(paths) {
  return paths.map((path) => `${path}\0`).join('')
}

/** Staged into `env`'s index: exactly the given files. */
async function stageFiles(root, paths, env) {
  await git(root, ['read-tree', '--empty'], { env })
  if (paths.length > 0) {
    await git(root, ['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: pathList(paths) })
  }
}

async function discardGitDirectory(root) {
  // The marker goes first: an interrupted reset must not leave trusted partial metadata.
  await rm(versionFile(root), { force: true }).catch(() => {})
  await rm(join(root, '.git'), { recursive: true, force: true })
}

async function resetRepository(root, contents) {
  await discardGitDirectory(root)
  await git(root, ['init', '-q'])
  const paths = contents === 'current' ? (await eligibleFiles(root)).included : []
  await stageFiles(root, paths, {})
  await git(root, ['commit', '-q', '--allow-empty', '-m', 'Initialize memory baseline'])
  await writeFile(versionFile(root), BASELINE_VERSION)
}

/** Replaces any `.git` with a fresh one-commit baseline of the current files. */
export async function resetGitRepository(root) {
  await resetRepository(root, 'current')
}

async function isUsableBaseline(root) {
  try {
    if (!(await lstat(join(root, '.git'))).isDirectory()) return false
    if ((await readFile(versionFile(root), 'utf8')) !== BASELINE_VERSION) return false
    await git(root, ['rev-parse', '--verify', 'HEAD^{tree}'])
    return true
  } catch {
    return false
  }
}

/** Keeps a valid baseline; anything else becomes an empty one, so every file reads as added. */
export async function ensureGitBaselineRepository(root) {
  if (!(await isUsableBaseline(root))) await resetRepository(root, 'empty')
}

const STATUS_LABELS = new Set(['A', 'M', 'D'])

function parseNameStatus(output) {
  const fields = output.split('\0').filter((field) => field.length > 0)
  const changes = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index][0]
    changes.push({ status: STATUS_LABELS.has(status) ? status : 'M', path: fields[index + 1] })
  }
  return changes
}

/**
 * Diffs the current bounded files against the latest baseline.
 * @returns {Promise<{changes:{status:'A'|'M'|'D', path:string}[], unifiedDiff:string}>}
 */
export async function diffSinceLatestInit(root) {
  await ensureGitBaselineRepository(root)
  const { included, excluded } = await eligibleFiles(root)
  if (excluded.length > 0) {
    // A tracked file that grew past the limit can no longer be compared.
    const tracked = new Set((await git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])).split('\0'))
    if (excluded.some((path) => tracked.has(path))) await resetRepository(root, 'empty')
  }
  const env = { GIT_INDEX_FILE: TEMPORARY_INDEX }
  try {
    await stageFiles(root, included, env)
    const flags = ['--cached', '--no-renames', '--no-ext-diff', '--no-color']
    const nameStatus = await git(root, ['diff', ...flags, '--name-status', '-z', 'HEAD'], { env })
    const unifiedDiff = await git(root, ['diff', ...flags, 'HEAD'], { env })
    return { changes: parseNameStatus(nameStatus), unifiedDiff }
  } finally {
    await rm(join(root, TEMPORARY_INDEX), { force: true })
  }
}
