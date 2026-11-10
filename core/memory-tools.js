// Port of codex-rs/ext/memories/src/local: read access to the memory root and
// append-only ad-hoc notes. Paths are confined to the root, hidden entries
// (including the baseline repository) are invisible, symlinks are refused.

import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { truncateTextToTokens } from './truncate.js'

export const DEFAULT_LIST_MAX_RESULTS = 2_000
export const DEFAULT_SEARCH_MAX_RESULTS = 200
const DEFAULT_READ_MAX_TOKENS = 20_000
const AD_HOC_NOTES_DIR = ['extensions', 'ad_hoc', 'notes']
const AD_HOC_NOTE_FILENAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9-]{1,80}\.md$/

/** A caller mistake, reported to the model rather than treated as a crash. */
export class MemoryToolError extends Error {}

async function metadataOrNone(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function display(root, path) {
  return relative(root, path).split(sep).join('/')
}

function paginate(items, cursor, maxResults) {
  const start = parseCursor(cursor)
  if (start > items.length) throw new MemoryToolError(`cursor '${start}' exceeds result count`)
  const end = Math.min(start + maxResults, items.length)
  const truncated = end < items.length
  return { page: items.slice(start, end), next_cursor: truncated ? String(end) : null, truncated }
}

function parseCursor(cursor) {
  if (cursor === undefined || cursor === null) return 0
  if (!/^\d+$/.test(String(cursor))) throw new MemoryToolError(`cursor '${cursor}' must be a non-negative integer`)
  return Number(cursor)
}

function rejectSymlink(path, metadata) {
  if (metadata.isSymbolicLink()) throw new MemoryToolError(`path '${path}' must not be a symlink`)
}

async function sortedEntries(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function prepareForComparison(value, caseSensitive, normalized) {
  const cased = caseSensitive ? value : value.toLowerCase()
  return normalized ? cased.replace(/[^\p{L}\p{N}]/gu, '') : cased
}

function linesOf(content) {
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''))
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function buildMatch(root, path, lines, startIndex, endIndex, contextLines, matchedQueries) {
  const contentStart = Math.max(startIndex - contextLines, 0)
  const contentEnd = Math.min(endIndex + contextLines + 1, lines.length)
  return {
    path: display(root, path),
    match_line_number: startIndex + 1,
    content_start_line_number: contentStart + 1,
    content: lines.slice(contentStart, contentEnd).join('\n'),
    matched_queries: matchedQueries,
  }
}

function collectMatches(root, path, lines, flags, queries, mode, contextLines) {
  const named = (matched) => queries.filter((_query, index) => matched[index])
  const matches = []
  if (mode.type === 'any' || mode.type === 'all_on_same_line') {
    const accept = mode.type === 'any' ? (matched) => matched.some(Boolean) : (matched) => matched.every(Boolean)
    flags.forEach((matched, index) => {
      if (accept(matched)) matches.push(buildMatch(root, path, lines, index, index, contextLines, named(matched)))
    })
    return matches
  }
  const windows = []
  for (let start = 0; start < lines.length; start += 1) {
    if (!flags[start].some(Boolean)) continue
    const last = Math.min(start + mode.line_count - 1, lines.length - 1)
    const combined = queries.map(() => false)
    for (let end = start; end <= last; end += 1) {
      flags[end].forEach((matched, index) => {
        combined[index] ||= matched
      })
      if (combined.every(Boolean)) {
        windows.push({ start, end, combined: [...combined] })
        break
      }
    }
  }
  for (const window of windows) {
    const containsAnother = windows.some(
      (other) => other !== window && window.start <= other.start && window.end >= other.end && (window.start !== other.start || window.end !== other.end),
    )
    if (!containsAnother) matches.push(buildMatch(root, path, lines, window.start, window.end, contextLines, named(window.combined)))
  }
  return matches
}

export class LocalMemoriesBackend {
  /** @param {string} root */
  constructor(root) {
    this.root = root
  }

  async #resolveScopedPath(relativePath) {
    if (relativePath === undefined || relativePath === null) return this.root
    const components = relativePath.split('/').filter((part) => part !== '' && part !== '.')
    if (isAbsolute(relativePath) || components.includes('..')) {
      throw new MemoryToolError(`path '${relativePath}' must stay within the memories root`)
    }
    if (components.some((part) => part.startsWith('.'))) throw new MemoryToolError(`path '${relativePath}' was not found`)
    let scoped = this.root
    for (const component of components) {
      scoped = join(scoped, component)
      const metadata = await metadataOrNone(scoped)
      if (metadata === undefined) return join(this.root, ...components)
      rejectSymlink(relativePath, metadata)
    }
    return scoped
  }

  async #existing(relativePath) {
    const path = await this.#resolveScopedPath(relativePath)
    const metadata = await metadataOrNone(path)
    if (metadata === undefined) throw new MemoryToolError(`path '${relativePath ?? ''}' was not found`)
    return { path, metadata }
  }

  async list({ path: requested, cursor, maxResults = DEFAULT_LIST_MAX_RESULTS }) {
    const { path, metadata } = await this.#existing(requested)
    let entries = []
    if (metadata.isFile()) {
      entries = [{ path: display(this.root, path), entry_type: 'file' }]
    } else if (metadata.isDirectory()) {
      for (const entry of await sortedEntries(path)) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        if (entry.isDirectory() || entry.isFile()) {
          entries.push({ path: display(this.root, join(path, entry.name)), entry_type: entry.isDirectory() ? 'directory' : 'file' })
        }
      }
    }
    const { page, next_cursor, truncated } = paginate(entries, cursor, Math.min(maxResults, DEFAULT_LIST_MAX_RESULTS))
    return { path: requested ?? null, entries: page, next_cursor, truncated }
  }

  async read({ path: requested, lineOffset = 1, maxLines, maxTokens = DEFAULT_READ_MAX_TOKENS }) {
    if (lineOffset < 1) throw new MemoryToolError('line_offset must be a 1-indexed line number')
    if (maxLines === 0) throw new MemoryToolError('max_lines must be a positive integer')
    const { path, metadata } = await this.#existing(requested)
    if (!metadata.isFile()) throw new MemoryToolError(`path '${requested}' is not a file`)
    const original = await readFile(path, 'utf8')
    const lines = original.split('\n')
    if (lineOffset > lines.length) throw new MemoryToolError('line_offset exceeds file length')
    const selected = lines.slice(lineOffset - 1, maxLines === undefined ? undefined : lineOffset - 1 + maxLines).join('\n')
    const reachedEnd = maxLines === undefined || lineOffset - 1 + maxLines >= lines.length
    const content = truncateTextToTokens(selected, maxTokens)
    return { path: requested, start_line_number: lineOffset, content, truncated: !reachedEnd || content !== selected }
  }

  async search({ queries, matchMode = { type: 'any' }, path: requested, cursor, contextLines = 0, caseSensitive = false, normalized = false, maxResults = DEFAULT_SEARCH_MAX_RESULTS }) {
    const trimmed = queries.map((query) => query.trim())
    if (trimmed.length === 0 || trimmed.some((query) => query.length === 0)) {
      throw new MemoryToolError('queries must not be empty or contain empty strings')
    }
    if (matchMode.type === 'all_within_lines' && !(matchMode.line_count > 0)) {
      throw new MemoryToolError('all_within_lines.line_count must be a positive integer')
    }
    const prepared = trimmed.map((query) => prepareForComparison(query, caseSensitive, normalized))
    if (prepared.some((query) => query.length === 0)) throw new MemoryToolError('queries must not be empty or contain empty strings')
    const { path: start, metadata } = await this.#existing(requested)

    const matches = []
    const searchFile = async (path) => {
      const lines = linesOf(await readFile(path, 'utf8'))
      const flags = lines.map((line) => {
        const comparable = prepareForComparison(line, caseSensitive, normalized)
        return prepared.map((query) => comparable.includes(query))
      })
      matches.push(...collectMatches(this.root, path, lines, flags, trimmed, matchMode, contextLines))
    }
    if (metadata.isFile()) await searchFile(start)
    else if (metadata.isDirectory()) {
      const pending = [start]
      while (pending.length > 0) {
        const directory = pending.pop()
        for (const entry of await sortedEntries(directory)) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
          if (entry.isDirectory()) pending.push(join(directory, entry.name))
          else if (entry.isFile()) await searchFile(join(directory, entry.name))
        }
      }
    }
    matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.match_line_number - b.match_line_number))
    const { page, next_cursor, truncated } = paginate(matches, cursor, Math.min(maxResults, DEFAULT_SEARCH_MAX_RESULTS))
    return { queries: trimmed, match_mode: matchMode, path: requested ?? null, matches: page, next_cursor, truncated }
  }

  async addAdHocNote({ filename, note }) {
    if (Buffer.byteLength(filename) > 128 || !AD_HOC_NOTE_FILENAME.test(filename)) {
      throw new MemoryToolError(`filename '${filename}' must use YYYY-MM-DDTHH-MM-SS-<slug>.md with a lowercase ASCII slug`)
    }
    if (note.trim().length === 0) throw new MemoryToolError('ad-hoc note must not be empty')
    let directory = this.root
    for (const component of AD_HOC_NOTES_DIR) {
      directory = join(directory, component)
      await mkdir(directory, { recursive: true })
      rejectSymlink(directory, await lstat(directory))
    }
    let handle
    try {
      handle = await open(join(directory, filename), 'wx')
    } catch (error) {
      if (error.code === 'EEXIST') throw new MemoryToolError(`ad-hoc note '${filename}' already exists`)
      throw error
    }
    try {
      await handle.writeFile(note)
    } finally {
      await handle.close()
    }
    return {}
  }
}
