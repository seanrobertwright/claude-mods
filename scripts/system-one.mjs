// Pure helpers that keep the System One client's copies and fields in step (ADR-0004),
// kept apart so tests can import them without running the gate.

/** The mods among `copies` ({ mod, text }) whose copy is not byte for byte `source`, in the order given. */
export function copyMismatches(source, copies) {
  return copies.filter(copy => copy.text !== source).map(copy => copy.mod)
}

/** The three fields every mod carrying a copy declares alike (#85, #86). */
export const SHARED_FIELDS = ['jevApiKey', 'modelChoice', 'layaPort']

/**
 * What must match of a field: everything but its description, since each mod's
 * `modelChoice` description says what that mod sends. The title is kept: #85
 * fixes it to be the same in every mod.
 */
function comparable(field) {
  return JSON.stringify({
    type: field.type,
    title: field.title,
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
      if (manifest !== first && model !== undefined && model !== null && comparable(field) !== comparable(model)) {
        problems.push(`${manifest.mod}: ${name} differs from ${first.mod}'s`)
      }
    }
  }
  return problems
}
