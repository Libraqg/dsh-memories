// Port of codex-rs/memories/write/src/prompts.rs.

import { existsSync, readFileSync } from 'node:fs'
import { memoryExtensionsRoot } from './extensions.js'
import { truncateTextToTokens } from './truncate.js'
import { WORKSPACE_DIFF_FILENAME } from './workspace.js'

const DEFAULT_ROLLOUT_TOKEN_LIMIT = 150_000
const CONTEXT_WINDOW_PERCENT = 70
const EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95

function loadTemplate(name) {
  return readFileSync(new URL(`./templates/memories/${name}`, import.meta.url), 'utf8')
}

/** Renders `{{ name }}` placeholders in one pass, so substituted text is never re-expanded. */
export function renderTemplate(template, variables) {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`template variable "${name}" is not provided`)
    return variables[name]
  })
}

export const STAGE_ONE_SYSTEM_PROMPT = loadTemplate('stage_one_system.md')
const STAGE_ONE_INPUT_TEMPLATE = loadTemplate('stage_one_input.md')

const CONSOLIDATION_TEMPLATE = loadTemplate('consolidation.md')

// Verbatim from prompt_blocks in codex-rs/memories/write/src/lib.rs.
const EXTENSIONS_FOLDER_STRUCTURE = `
Memory extensions (under {{ memory_extensions_root }}/):

- <extension_name>/instructions.md
  - Source-specific guidance for interpreting additional memory signals. If an
    extension folder exists, you must read its instructions.md to determine how to use this memory
    source.

If the user has any memory extensions, you MUST read the instructions for each extension to
determine how to use the memory source. If the workspace diff shows deleted extension resource files,
remove stale memories derived only from those resources. If it has no extension folders, continue
with the standard memory inputs only.
`

const EXTENSIONS_PRIMARY_INPUTS = `
Optional source-specific inputs:
Under \`{{ memory_extensions_root }}/\`:

- \`<extension_name>/instructions.md\`
  - If extension folders exist, read each instructions.md first and follow it when interpreting
    that extension's memory source.

If the workspace diff shows deleted memory extension resources, use that extension-specific deletion
signal to remove stale memories derived only from those resources.
`

/** Builds the consolidation agent's prompt for one memory root. */
export function buildConsolidationPrompt(memoryRoot) {
  const extensionsRoot = memoryExtensionsRoot(memoryRoot)
  const block = (template) =>
    existsSync(extensionsRoot) ? renderTemplate(template, { memory_extensions_root: extensionsRoot }) : ''
  return renderTemplate(CONSOLIDATION_TEMPLATE, {
    memory_root: memoryRoot,
    memory_extensions_folder_structure: block(EXTENSIONS_FOLDER_STRUCTURE),
    memory_extensions_primary_inputs: block(EXTENSIONS_PRIMARY_INPUTS),
    phase2_workspace_diff_file: WORKSPACE_DIFF_FILENAME,
  })
}

/** Token budget for one rollout: 70% of the model's effective input window. */
export function rolloutTokenLimit(contextWindow) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return DEFAULT_ROLLOUT_TOKEN_LIMIT
  const effective = Math.floor((contextWindow * EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100)
  return Math.max(Math.floor((effective * CONTEXT_WINDOW_PERCENT) / 100), 1)
}

/** Builds the stage-one user message, truncating the rollout while keeping head and tail. */
export function buildStageOneInputMessage({ contextWindow, rolloutPath, rolloutCwd, rolloutContents }) {
  return renderTemplate(STAGE_ONE_INPUT_TEMPLATE, {
    rollout_path: rolloutPath,
    rollout_cwd: rolloutCwd,
    rollout_contents: truncateTextToTokens(rolloutContents, rolloutTokenLimit(contextWindow)),
  })
}
