// Port of codex-rs/ext/memories/src/prompts.rs (V1), plus the documented edits
// to the upstream read-path template (D7, D8, D14). The template file itself
// stays verbatim so upstream changes remain diffable.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { renderTemplate } from './prompts.js'
import { truncateTextToTokens } from './truncate.js'

const SUMMARY_TOKEN_LIMIT = 2_500
export const AD_HOC_NOTE_TOOL = 'memories_add_ad_hoc_note'

const template = await readFile(new URL('./templates/memories/read_path.md', import.meta.url), 'utf8')

function cut(text, start, end) {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  if (from === -1 || to === -1) throw new Error(`read_path template changed: cannot find "${start}"`)
  return text.slice(0, from) + text.slice(to)
}

function replace(text, before, after) {
  if (!text.includes(before)) throw new Error(`read_path template changed: cannot find "${before}"`)
  return text.replace(before, () => after)
}

function adaptTemplate(source) {
  // D8: raw session logs are compressed and cannot be searched by path.
  let text = cut(source, '  - The paths of these entries can be found', 'Quick memory pass (when applicable):')
  text = text.replace('Quick memory pass (when applicable):', '\nQuick memory pass (when applicable):')
  text = cut(text, '4. If above are not clear and you need exact commands', '5. If there are no relevant hits')
  text = replace(text, '5. If there are no relevant hits', '4. If there are no relevant hits')
  // D7: the host cannot hide citation markup, so usage is derived from reads.
  text = cut(text, 'Memory citation requirements:', 'Updating memories:')
  // D14: the notes folder is outside the workspace sandbox; a tool writes there.
  return replace(
    text,
    '- Write your update in {{ base_path }}/extensions/ad_hoc/notes/',
    `- Write your update with the \`${AD_HOC_NOTE_TOOL}\` tool, which stores it in {{ base_path }}/extensions/ad_hoc/notes/`,
  )
}

const adaptedTemplate = adaptTemplate(template)

/**
 * Builds the read-path instructions for a new session.
 * @returns {Promise<string|undefined>} undefined until a summary exists
 */
export async function buildMemoryReadInstructions(memoryRoot) {
  let summary
  try {
    summary = await readFile(join(memoryRoot, 'memory_summary.md'), 'utf8')
  } catch {
    return undefined
  }
  const trimmed = truncateTextToTokens(summary.trim(), SUMMARY_TOKEN_LIMIT)
  if (trimmed.length === 0) return undefined
  return renderTemplate(adaptedTemplate, { base_path: memoryRoot, memory_summary: trimmed })
}
