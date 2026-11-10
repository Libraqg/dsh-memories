// File tools scoped to the consolidation agent. DSH hosts tools either globally
// or inside agent presets depending on the profile, so the agent masks everything
// it inherits and uses these instead. Confinement lives in this code: every path
// must resolve inside the memory root, and `.git` and symlinks are refused.

import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { MemoryToolError } from '../../core/index.js'

const TEXT_OUTPUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
const MAX_LINES_RETURNED = 2_000
const MAX_MATCHES = 500
const STRING = { type: 'string' }

function isInside(root, target) {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function refuseSymlinks(root, target) {
  let current = root
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (metadata.isSymbolicLink()) throw new MemoryToolError(`symbolic links are not allowed: ${relative(root, current)}`)
  }
}

/** Maps a model-supplied path into the root, whichever spelling of the root it used. */
async function confine(roots, requested) {
  if (typeof requested !== 'string' || requested.length === 0) throw new MemoryToolError('a file path is required')
  const absolute = resolve(roots[0], requested)
  const root = roots.find((candidate) => isInside(candidate, absolute))
  if (root === undefined) throw new MemoryToolError(`path is outside the memory root: ${requested}`)
  if (relative(root, absolute).split(sep).includes('.git')) throw new MemoryToolError('the memory baseline repository is off limits')
  await refuseSymlinks(root, absolute)
  return { root, absolute }
}

async function walkFiles(root, start) {
  const files = []
  const pending = [start]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files.map((path) => relative(root, path).split(sep).join('/')).sort()
}

/** Translates `*`, `**`, `?` and `{a,b}` into an anchored regular expression. */
export function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1
      if (pattern[index + 1] === '/') {
        index += 1
        source += '(?:.*/)?'
      } else {
        source += '.*'
      }
    } else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else if (character === '{') source += '(?:'
    else if (character === '}') source += ')'
    else if (character === ',') source += '|'
    else source += character.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

function tool(name, description, properties, required, execute) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: TEXT_OUTPUT,
    execute,
  }
}

/** @param {string[]} roots the memory root, in every spelling a model may see */
export function consolidationToolDefinitions(roots) {
  return [
    tool(
      'read',
      'Read a text file in the memory folder. Returns numbered lines; use offset and limit to page through large files.',
      { file_path: STRING, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } },
      ['file_path'],
      async ({ file_path: path, offset = 1, limit = MAX_LINES_RETURNED }) => {
        const { absolute } = await confine(roots, path)
        const lines = (await readFile(absolute, 'utf8')).split('\n')
        const end = Math.min(offset - 1 + Math.min(limit, MAX_LINES_RETURNED), lines.length)
        const body = lines.slice(offset - 1, end).map((line, index) => `${offset + index}\t${line}`).join('\n')
        return end < lines.length ? `${body}\n[${lines.length} lines in total; continue with offset ${end + 1}]` : body
      },
    ),
    tool(
      'write',
      'Create or overwrite a file in the memory folder, creating parent directories as needed.',
      { file_path: STRING, content: STRING },
      ['file_path', 'content'],
      async ({ file_path: path, content }) => {
        const { absolute } = await confine(roots, path)
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, content)
        return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`
      },
    ),
    tool(
      'edit',
      'Replace an exact string in a file in the memory folder. old_string must be unique unless replace_all is true.',
      { file_path: STRING, old_string: STRING, new_string: STRING, replace_all: { type: 'boolean' } },
      ['file_path', 'old_string', 'new_string'],
      async ({ file_path: path, old_string: before, new_string: after, replace_all: replaceAll = false }) => {
        const { absolute } = await confine(roots, path)
        const content = await readFile(absolute, 'utf8')
        const occurrences = before.length === 0 ? 0 : content.split(before).length - 1
        if (occurrences === 0) throw new MemoryToolError('old_string was not found')
        if (occurrences > 1 && !replaceAll) throw new MemoryToolError(`old_string occurs ${occurrences} times; make it unique or set replace_all`)
        await writeFile(absolute, replaceAll ? content.split(before).join(after) : content.replace(before, () => after))
        return `Edited ${path}`
      },
    ),
    tool(
      'glob',
      'List files in the memory folder whose path matches a glob pattern such as **/*.md.',
      { pattern: STRING, path: STRING },
      ['pattern'],
      async ({ pattern, path = '.' }) => {
        if (isAbsolute(pattern) || pattern.split('/').includes('..')) throw new MemoryToolError('glob patterns must stay inside the memory root')
        const { root, absolute } = await confine(roots, path)
        const matcher = globToRegExp(pattern)
        const prefix = relative(root, absolute)
        const files = (await walkFiles(root, absolute)).filter((file) => matcher.test(prefix === '' ? file : file.slice(prefix.length + 1)))
        return files.length === 0 ? 'No files matched.' : files.join('\n')
      },
    ),
    tool(
      'grep',
      'Search file contents in the memory folder with a regular expression. Returns path:line:text.',
      { pattern: STRING, path: STRING, include: { type: 'string', description: 'Only search files matching this glob.' } },
      ['pattern'],
      async ({ pattern, path = '.', include }) => {
        const { root, absolute } = await confine(roots, path)
        let expression
        try {
          expression = new RegExp(pattern, 'u')
        } catch {
          throw new MemoryToolError(`invalid regular expression: ${pattern}`)
        }
        const metadata = await lstat(absolute)
        const files = metadata.isFile() ? [relative(root, absolute).split(sep).join('/')] : await walkFiles(root, absolute)
        const filter = include === undefined ? undefined : globToRegExp(include.includes('/') ? include : `**/${include}`)
        const matches = []
        for (const file of files) {
          if (filter !== undefined && !filter.test(file)) continue
          const lines = (await readFile(join(root, file), 'utf8')).split('\n')
          for (const [index, line] of lines.entries()) {
            if (expression.test(line)) matches.push(`${file}:${index + 1}:${line}`)
            if (matches.length >= MAX_MATCHES) return `${matches.join('\n')}\n[stopped after ${MAX_MATCHES} matches]`
          }
        }
        return matches.length === 0 ? 'No matches.' : matches.join('\n')
      },
    ),
  ]
}
