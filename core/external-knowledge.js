// A human-maintained knowledge base the agent can read but memory must not copy
// (D15). Codex applies the same principle to AGENTS.md: human-maintained knowledge
// stays out of generated memory. It recognizes AGENTS.md as an injected block; a
// knowledge base arrives through ordinary tool calls, so it is matched by path.

import { basename } from 'node:path'

const PATH_DELIMITERS = '\\s"\'`<>|;,:()\\[\\]{}，。；：、（）【】「」'

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {object} options
 * @param {string} options.root Absolute path of the knowledge base.
 * @param {string[]} [options.sessionExcludedPaths] Root-relative paths whose use removes the whole session.
 */
export function createExternalKnowledgePolicy({ root, sessionExcludedPaths = [] }) {
  const name = basename(root)
  const escaped = escapeRegExp(name)
  // Matches ".../Name", ".../Name/rest" and a relative "Name/rest", under any parent spelling.
  const reference = new RegExp(`(?:(?<=/)${escaped}(?![\\w-])|(?<![\\w/-])${escaped}(?=/))(/[^${PATH_DELIMITERS}]*)?`, 'gu')
  const excluded = sessionExcludedPaths.map((path) => path.replace(/^\/+|\/+$/g, ''))
  const relativeExcluded = excluded.map(
    (path) => new RegExp(`(?<![\\w-])${escapeRegExp(path)}(?:/|(?![\\w-]))`, 'u'),
  )

  function excludesSession(path) {
    return excluded.some((entry) => path === entry || path.startsWith(`${entry}/`))
  }

  /** @returns {{paths:string[], excludesSession:boolean}} root-relative references found in text */
  function scan(text) {
    const paths = new Set()
    for (const match of text.matchAll(reference)) {
      paths.add((match[1] ?? '').replace(/^\/+|\/+$/g, '') || '.')
    }
    return { paths: [...paths], excludesSession: [...paths].some(excludesSession) }
  }

  return {
    scan,

    /** Whether a working directory is inside the knowledge base, and whether that alone excludes the session. */
    locate(directory) {
      const { paths, excludesSession: excludes } = scan(directory ?? '')
      return { inside: paths.length > 0, excludesSession: excludes }
    },

    /** Inside the knowledge base, a bare relative path such as "personal/x.md" is also a reference. */
    mentionsExcludedRelative(text) {
      return relativeExcluded.some((expression) => expression.test(text))
    },

    placeholder(paths) {
      return `[${name} content omitted: ${[...paths].sort().join(', ')}]`
    },
  }
}
