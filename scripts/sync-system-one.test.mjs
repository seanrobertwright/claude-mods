import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { syncCopies } from './sync-system-one.mjs'

test('the sync refreshes every copy that exists and adds none', t => {
  const root = mkdtempSync(join(tmpdir(), 'system-one-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = 'export const BOUND_CAP_MS = 10_000\n'
  mkdirSync(join(root, 'shared'))
  writeFileSync(join(root, 'shared', 'system-one.ts'), source)
  for (const mod of ['quick-reply', 'shelf', 'whats-next']) mkdirSync(join(root, 'mods', mod, 'hooks'), { recursive: true })
  writeFileSync(join(root, 'mods', 'quick-reply', 'hooks', 'system-one.ts'), 'old\n')
  writeFileSync(join(root, 'mods', 'whats-next', 'hooks', 'system-one.ts'), source)

  assert.deepEqual(syncCopies(root), ['quick-reply'])
  assert.equal(readFileSync(join(root, 'mods', 'quick-reply', 'hooks', 'system-one.ts'), 'utf8'), source)
  assert.equal(readFileSync(join(root, 'mods', 'whats-next', 'hooks', 'system-one.ts'), 'utf8'), source)
  assert.equal(existsSync(join(root, 'mods', 'shelf', 'hooks', 'system-one.ts')), false)
})
