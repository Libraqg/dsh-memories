// Enforces the layering rule: the memory core may import only `node:*` and
// its own modules, so a new harness never needs a core change.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => join(entry.parentPath, entry.name))
}

/** @returns {string[]} one human-readable line per illegal import */
export function findBoundaryViolations(coreDirectory) {
  const violations = []
  for (const file of javascriptFiles(coreDirectory)) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER)) {
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('.')) {
        const inside = !relative(coreDirectory, resolve(dirname(file), specifier)).startsWith(`..${sep}`)
        if (inside) continue
      }
      violations.push(`${relative(coreDirectory, file)}: illegal import "${specifier}"`)
    }
  }
  return violations
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findBoundaryViolations(fileURLToPath(new URL('../core/', import.meta.url)))
  for (const violation of violations) console.error(violation)
  if (violations.length > 0) process.exit(1)
  console.log('core boundary ok')
}
