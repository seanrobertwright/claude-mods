import assert from 'node:assert/strict'
import { test } from 'node:test'

import { modsForPaths } from './mods.mjs'

const MODS = ['auto-resume', 'github-panel', 'quick-reply', 'whats-next']

test('maps staged paths to the mods they belong to, once each, in mod order', () => {
  const paths = [
    'mods/whats-next/hooks/register.tsx',
    'README.md',
    'mods/quick-reply/tests/quick-reply.test.ts',
    'mods/whats-next/types/index.d.ts',
  ]
  assert.deepEqual(modsForPaths(paths, MODS), ['quick-reply', 'whats-next'])
})

test('ignores paths outside mods/, files directly in mods/, and mods that no longer exist', () => {
  assert.deepEqual(modsForPaths(['mods/README.md', 'scripts/x.mjs', 'mods/gone/hooks/a.ts'], MODS), [])
})

test('accepts Windows separators', () => {
  assert.deepEqual(modsForPaths(['mods\\auto-resume\\hooks\\plan.ts'], MODS), ['auto-resume'])
})
