import { expect, test } from 'claude-code/testing'

import { detectRows, parseScripts } from '../hooks/detect'

const SCRIPTS = ['dev', 'start', 'serve', 'preview']
const PACKAGE = JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' } })

test('the packageManager field wins over any lockfile', () => {
  const text = JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { dev: 'vite' } })
  expect(detectRows(text, ['package-lock.json', 'yarn.lock'], SCRIPTS)).toEqual({
    rows: [{ name: 'dev', argv: ['pnpm', 'run', 'dev'] }],
    conflict: [],
  })
})

test('each lockfile names its manager, and no lockfile means npm', () => {
  const managerOf = (lockfiles: string[]) => detectRows(PACKAGE, lockfiles, SCRIPTS).rows[0]?.argv[0]
  expect(managerOf(['pnpm-lock.yaml'])).toBe('pnpm')
  expect(managerOf(['yarn.lock'])).toBe('yarn')
  expect(managerOf(['bun.lock'])).toBe('bun')
  expect(managerOf(['bun.lockb'])).toBe('bun')
  expect(managerOf(['package-lock.json'])).toBe('npm')
  expect(managerOf([])).toBe('npm')
})

test('two lockfiles and no packageManager: the rows show, the conflict names both', () => {
  const detected = detectRows(PACKAGE, ['package-lock.json', 'pnpm-lock.yaml'], SCRIPTS)
  expect(detected.rows.map(row => row.name)).toEqual(['dev', 'preview'])
  expect(detected.conflict).toEqual(['package-lock.json', 'pnpm-lock.yaml'])
})

test('both bun lockfiles are one manager, not a conflict', () => {
  expect(detectRows(PACKAGE, ['bun.lock', 'bun.lockb'], SCRIPTS)).toEqual({
    rows: [
      { name: 'dev', argv: ['bun', 'run', 'dev'] },
      { name: 'preview', argv: ['bun', 'run', 'preview'] },
    ],
    conflict: [],
  })
  expect(detectRows(PACKAGE, ['bun.lockb', 'yarn.lock'], SCRIPTS).conflict).toEqual(['yarn.lock', 'bun.lockb'])
})

test('only the scripts the setting names become rows, in the setting order; a monorepo root fan-out script is an ordinary row', () => {
  const text = JSON.stringify({ scripts: { preview: 'vite preview', dev: 'turbo run dev', lint: 'eslint .' } })
  expect(detectRows(text, [], SCRIPTS).rows).toEqual([
    { name: 'dev', argv: ['npm', 'run', 'dev'] },
    { name: 'preview', argv: ['npm', 'run', 'preview'] },
  ])
})

test('no root package.json, or one that is not JSON, detects nothing', () => {
  expect(detectRows(undefined, ['package-lock.json'], SCRIPTS)).toEqual({ rows: [], conflict: [] })
  expect(detectRows('{ nope', [], SCRIPTS)).toEqual({ rows: [], conflict: [] })
})

test('the scripts setting splits on commas, trims, drops empties, and reads the default when empty', () => {
  expect(parseScripts(' dev,  storybook ,,web ')).toEqual(['dev', 'storybook', 'web'])
  expect(parseScripts(' , ')).toEqual(SCRIPTS)
  expect(parseScripts(undefined)).toEqual(SCRIPTS)
})
