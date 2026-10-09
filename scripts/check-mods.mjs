// Checks every mod under mods/: tsc, ESLint, claude plugin validate, claude plugin test.
// First, whatever is staged, it checks that each mod's copy of the System One
// client matches shared/system-one.ts and that those mods' System One fields agree.
// Then, on a full run or when shared/ or a copy of the client is staged, it
// type-checks, lints and tests shared/ (the client's own tests).
// Usage: node scripts/check-mods.mjs [--staged]
//   --staged  only the mods with staged changes (what the pre-commit hook runs);
//             the System One check then reads the files as staged
// Stops at the first failure and names the mod and the step.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { modsForPaths } from './mods.mjs'
import { COPY, copyMismatches, fieldMismatches, modsWithCopy, SOURCE } from './system-one.mjs'

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
 *
 * Claude Code 2.1.295 loads the mod but writes no types (2.1.293 and 2.1.294
 * do; issue #176). CHECK_MODS_CLAUDE names the binary for this one load, such
 * as ~/.local/share/claude/versions/2.1.294; the other checks keep `claude`.
 */
function ensureTypes(mod) {
  const generated = join(MODS_DIR, mod, '.claude-plugin', 'types', 'tsconfig.json')
  if (existsSync(generated)) return
  console.log(`check-mods: ${mod}: generating types (one headless load)`)
  const claude = process.env.CHECK_MODS_CLAUDE || 'claude'
  const run = spawnSync(
    claude,
    ['-p', '--plugin-dir', join('mods', mod), '--setting-sources', '', '--no-session-persistence'],
    {
      cwd: ROOT,
      input: '/cost',
      encoding: 'utf8',
      timeout: TYPES_TIMEOUT_MS,
    },
  )
  if (run.error !== undefined) fail(mod, 'generating types', run.error.message)
  if (!existsSync(generated)) {
    fail(
      mod,
      'generating types',
      `${claude} did not write ${generated}. Claude Code 2.1.295 writes no types (issue #176): ` +
        'set CHECK_MODS_CLAUDE to a 2.1.293 or 2.1.294 binary, or copy .claude-plugin/types/ from another checkout.',
    )
  }
}

/** A file's text as staged, or undefined when the index has no such file. */
function stagedText(path) {
  const run = spawnSync('git', ['show', `:${path.replaceAll('\\', '/')}`], { cwd: ROOT, encoding: 'utf8' })
  return run.status === 0 ? run.stdout : undefined
}

/** The mods whose copy of the client is staged, sorted. */
function stagedModsWithCopy() {
  const run = spawnSync('git', ['ls-files', '--cached', '-z', '--', 'mods/*/hooks/system-one.ts'], { cwd: ROOT, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr.trim()}`)
  return run.stdout.split('\0').filter(path => path !== '').map(path => path.split('/')[1]).sort()
}

/**
 * Fails when a copy of the System One client differs from shared/system-one.ts,
 * or when the mods carrying one declare jevApiKey, modelChoice or layaPort apart
 * (ADR-0004). Staged, it reads the index, so a source change committed without
 * its synced copies fails though nothing under mods/ is staged.
 */
function checkSystemOne(isStaged) {
  const read = isStaged ? stagedText : path => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : undefined)
  const mods = isStaged ? stagedModsWithCopy() : modsWithCopy(ROOT)
  const source = read(SOURCE)
  if (mods.length === 0 && source === undefined) return
  console.log('check-mods: system-one: copies and fields')
  if (source === undefined) fail('system-one', 'copy check', `${SOURCE} is missing`)
  const copies = mods.map(mod => ({ mod, text: read(join('mods', mod, COPY)) }))
  const stale = copyMismatches(source, copies)
  if (stale.length > 0) fail('system-one', 'copy check', `differs from ${SOURCE}: ${stale.join(', ')}; run npm run sync:system-one`)
  const manifests = mods.map(mod => {
    const text = read(join('mods', mod, '.claude-plugin', 'plugin.json'))
    return { mod, userConfig: text === undefined ? undefined : JSON.parse(text).userConfig }
  })
  const problems = fieldMismatches(manifests)
  if (problems.length > 0) fail('system-one', 'field check', problems.join('; '))
}

/** Whether a staged path is under shared/ or is a mod's copy of the client. */
function isSharedPath(path) {
  return path.startsWith('shared/') || /^mods\/[^/]+\/hooks\/system-one\.ts$/.test(path)
}

/**
 * Type-checks, lints and tests shared/: the client's rules are proved there once
 * (CONTEXT.md, System One client), not through each mod that carries a copy.
 * `node --test` strips the types, so it needs Node 22.18 or later.
 */
function checkShared() {
  const dir = join(ROOT, 'shared')
  if (!existsSync(dir)) return
  const tests = readdirSync(dir).filter(name => name.endsWith('.test.ts')).map(name => join('shared', name))
  step('shared', 'tsc', process.execPath, [TSC, '-p', 'shared', '--noEmit', '--strict'])
  step('shared', 'eslint', process.execPath, [ESLINT, '--max-warnings', '0', 'shared'])
  if (tests.length > 0) step('shared', 'node --test', process.execPath, ['--test', ...tests])
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
checkSystemOne(isStaged)
const staged = isStaged ? stagedPaths() : []
if (!isStaged || staged.some(isSharedPath)) {
  for (const tool of [TSC, ESLINT]) {
    if (!existsSync(tool)) {
      console.error(`check-mods: ${tool} is missing; run npm install first`)
      process.exit(1)
    }
  }
  checkShared()
}
const all = listMods()
const mods = isStaged ? modsForPaths(staged, all) : all
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
