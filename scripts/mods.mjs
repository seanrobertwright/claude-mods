// Pure helpers for check-mods.mjs, kept apart so tests can import them without running the gate.

/** The mods among `mods` that the repo-relative `paths` touch, once each, in the order of `mods`. */
export function modsForPaths(paths, mods) {
  const touched = new Set()
  for (const path of paths) {
    const parts = path.split(/[\\/]/)
    if (parts.length >= 3 && parts[0] === 'mods') touched.add(parts[1])
  }
  return mods.filter(mod => touched.has(mod))
}
