// Model-facing memory tools, the DSH shape of the Codex `dedicated_tools` set.
// Definitions are plain objects because a linked plugin cannot import DSH packages.

import { AD_HOC_NOTE_TOOL, MemoryToolError } from '../../core/index.js'

const JSON_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

const STRING = { type: 'string' }
const POSITIVE_INTEGER = { type: 'integer', minimum: 1 }

function isPlainInteger(value) {
  return value === undefined || (Number.isInteger(value) && value >= 1)
}

function checkArguments(args, required, integers) {
  for (const name of required) {
    if (args[name] === undefined) throw new MemoryToolError(`${name} is required`)
  }
  for (const name of integers) {
    if (!isPlainInteger(args[name])) throw new MemoryToolError(`${name} must be a positive integer`)
  }
}

function tool(name, description, properties, required, integers, run) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: JSON_OUTPUT,
    async execute(args) {
      checkArguments(args, required, integers)
      return JSON.stringify(await run(args))
    },
  }
}

const MATCH_MODE = {
  type: 'object',
  description: 'How multiple queries combine: {"type":"any"}, {"type":"all_on_same_line"}, or {"type":"all_within_lines","line_count":N}.',
  properties: { type: { type: 'string', enum: ['any', 'all_on_same_line', 'all_within_lines'] }, line_count: POSITIVE_INTEGER },
  required: ['type'],
}

/**
 * @param {import('../../core/index.js').LocalMemoriesBackend} backend
 */
export function memoryToolDefinitions(backend) {
  return [
    tool(
      'memories_list',
      'List files and directories in the memory folder. Paths are relative to the memory root.',
      { path: STRING, cursor: STRING, max_results: POSITIVE_INTEGER },
      [],
      ['max_results'],
      ({ path, cursor, max_results: maxResults }) => backend.list({ path, cursor, maxResults }),
    ),
    tool(
      'memories_read',
      'Read one file from the memory folder, optionally a line range. Paths are relative to the memory root.',
      { path: STRING, line_offset: POSITIVE_INTEGER, max_lines: POSITIVE_INTEGER },
      ['path'],
      ['line_offset', 'max_lines'],
      ({ path, line_offset: lineOffset, max_lines: maxLines }) => backend.read({ path, lineOffset, maxLines }),
    ),
    tool(
      'memories_search',
      'Search the memory folder for literal strings and return matching lines with their paths.',
      {
        queries: { type: 'array', items: STRING, minItems: 1 },
        match_mode: MATCH_MODE,
        path: STRING,
        cursor: STRING,
        context_lines: { type: 'integer', minimum: 0 },
        case_sensitive: { type: 'boolean' },
        normalized: { type: 'boolean', description: 'Ignore punctuation and spacing when comparing.' },
        max_results: POSITIVE_INTEGER,
      },
      ['queries'],
      ['max_results'],
      ({ queries, match_mode: matchMode, path, cursor, context_lines: contextLines, case_sensitive: caseSensitive, normalized, max_results: maxResults }) =>
        backend.search({ queries, matchMode, path, cursor, contextLines, caseSensitive, normalized, maxResults }),
    ),
    tool(
      AD_HOC_NOTE_TOOL,
      'Create one append-only ad-hoc memory note after the user explicitly asks you to remember, forget, or update something.',
      {
        filename: { type: 'string', description: 'YYYY-MM-DDTHH-MM-SS-<slug>.md; the slug uses only lowercase ASCII letters, digits and hyphens.' },
        note: { type: 'string', description: 'Verbatim Markdown note.' },
      },
      ['filename', 'note'],
      [],
      ({ filename, note }) => backend.addAdHocNote({ filename, note }),
    ),
  ]
}
