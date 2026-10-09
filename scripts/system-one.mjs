// Where the System One client and its copies live, and the pure helpers that keep
// the copies and fields in step (ADR-0004), kept apart so the gate and the sync
// script share them and tests can import them without running either.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The path of a mod's copy, relative to the mod. */
export const COPY = join('hooks', 'system-one.ts')
/** The path of the source, relative to the repo root. */
export const SOURCE = join('shared', 'system-one.ts')

/** The mods under `root`/mods that carry a copy, sorted. */
export function modsWithCopy(root) {
  const modsDir = join(root, 'mods')
  return readdirSync(modsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(modsDir, entry.name, COPY)))
    .map(entry => entry.name)
    .sort()
}

/** The mods among `copies` ({ mod, text }) whose copy is not byte for byte `source`, in the order given. */
export function copyMismatches(source, copies) {
  return copies.filter(copy => copy.text !== source).map(copy => copy.mod)
}

/** The three fields every mod carrying a copy declares alike (#85, #86). */
export const SHARED_FIELDS = ['jevApiKey', 'modelChoice', 'layaPort']

/** The fields whose title #85 fixes to be the same in every mod; #86 sets none for `layaPort`. */
const FIXED_TITLES = ['jevApiKey', 'modelChoice']

/**
 * What must match of a field: everything but its description, since each mod's
 * `modelChoice` description says what that mod sends, and the title of a field
 * no decision titles.
 */
function comparable(name, field) {
  return JSON.stringify({
    type: field.type,
    title: FIXED_TITLES.includes(name) ? field.title : undefined,
    sensitive: field.sensitive === true,
    default: field.default,
    options: field.options,
  })
}

/**
 * Where the shared fields of the mods carrying a copy ({ mod, userConfig }) part
 * ways: a field a mod lacks, or one that differs from the first mod's. One line each.
 */
export function fieldMismatches(manifests) {
  const problems = []
  const [first] = manifests
  for (const manifest of manifests) {
    for (const name of SHARED_FIELDS) {
      const field = manifest.userConfig?.[name]
      if (field === undefined || field === null) {
        problems.push(`${manifest.mod}: ${name} is missing`)
        continue
      }
      const model = first.userConfig?.[name]
      if (manifest !== first && model !== undefined && model !== null && comparable(name, field) !== comparable(name, model)) {
        problems.push(`${manifest.mod}: ${name} differs from ${first.mod}'s`)
      }
    }
  }
  return problems
}
