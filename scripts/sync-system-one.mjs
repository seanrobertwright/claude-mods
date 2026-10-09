// Copies shared/system-one.ts over each mod's hooks/system-one.ts (ADR-0004).
// Usage: npm run sync:system-one
// Only copies that already exist are refreshed: a mod takes the client by
// carrying a copy, and this script never adds one.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { COPY, modsWithCopy, SOURCE } from './system-one.mjs'

/** Writes the source over every copy under `root` that differs from it; returns the mods it rewrote. */
export function syncCopies(root) {
  const source = readFileSync(join(root, SOURCE), 'utf8')
  const rewritten = []
  for (const mod of modsWithCopy(root)) {
    const copy = join(root, 'mods', mod, COPY)
    if (readFileSync(copy, 'utf8') === source) continue
    writeFileSync(copy, source)
    rewritten.push(mod)
  }
  return rewritten
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..')
  const rewritten = syncCopies(root)
  console.log(rewritten.length === 0 ? 'sync-system-one: every copy already matches' : `sync-system-one: refreshed ${rewritten.join(', ')}`)
}
