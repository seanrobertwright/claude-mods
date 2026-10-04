// Checks every mod under mods/: tsc, ESLint, claude plugin validate, claude plugin test.
// Usage: node scripts/check-mods.mjs [--staged]
//   --staged  only the mods with staged changes (what the pre-commit hook runs)
// Stops at the first failure and names the mod and the step.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { modsForPaths } from './mods.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const MODS_DIR = join(ROOT, 'mods')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const ESLINT = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
/** A load takes seconds; past this the headless run is stuck. */
const TYPES_TIMEOUT_MS = 120_000

/** Every directory under mods/, sorted. */
function listMods() {
  return readdirSync(MODS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

function stagedPaths() {
  const run = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: ROOT, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git diff --cached failed: ${run.stderr.trim()}`)
  return run.stdout.split('\0').filter(path => path !== '')
}

function fail(mod, step, detail) {
  console.error(`check-mods: ${mod}: ${step} failed${detail === '' ? '' : ` (${detail})`}`)
  process.exit(1)
}

/** Runs a step with its output shown; a non-zero exit fails the mod. */
function step(mod, name, command, args) {
  console.log(`check-mods: ${mod}: ${name}`)
  const run = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (run.error !== undefined) fail(mod, name, run.error.message)
  if (run.status !== 0) fail(mod, name, `exit ${run.status}`)
}

/**
 * The mod's tsconfig extends .claude-plugin/types/tsconfig.json, which only a
 * load of the mod writes (validate and test do not). A headless run of a local
 * command loads it without a model call. No surface shows that session, so
 * every mod stays quiet in it: whats-next starts no headless /ask-sean run.
 */
function ensureTypes(mod) {
  const generated = join(MODS_DIR, mod, '.claude-plugin', 'types', 'tsconfig.json')
  if (existsSync(generated)) return
  console.log(`check-mods: ${mod}: generating types (one headless load)`)
  const run = spawnSync(
    'claude',
    ['-p', '--plugin-dir', join('mods', mod), '--setting-sources', '', '--no-session-persistence'],
    {
      cwd: ROOT,
      input: '/cost',
      encoding: 'utf8',
      timeout: TYPES_TIMEOUT_MS,
    },
  )
  if (run.error !== undefined) fail(mod, 'generating types', run.error.message)
  if (!existsSync(generated)) fail(mod, 'generating types', `claude did not write ${generated}`)
}

function checkMod(mod) {
  const dir = join('mods', mod)
  ensureTypes(mod)
  step(mod, 'tsc', process.execPath, [TSC, '-p', dir, '--noEmit', '--strict'])
  step(mod, 'eslint', process.execPath, [ESLINT, '--max-warnings', '0', dir])
  step(mod, 'plugin validate', 'claude', ['plugin', 'validate', dir])
  step(mod, 'plugin test', 'claude', ['plugin', 'test', dir])
}

const isStaged = process.argv.includes('--staged')
const all = listMods()
const mods = isStaged ? modsForPaths(stagedPaths(), all) : all
if (mods.length === 0) {
  console.log(isStaged ? 'check-mods: no staged changes under mods/' : 'check-mods: no mods under mods/')
} else {
  for (const tool of [TSC, ESLINT]) {
    if (!existsSync(tool)) {
      console.error(`check-mods: ${tool} is missing; run npm install first`)
      process.exit(1)
    }
  }
  for (const mod of mods) checkMod(mod)
  console.log(`check-mods: ${mods.length} mod(s) passed: ${mods.join(', ')}`)
}
