import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { COPY, copyMismatches, fieldMismatches, modsWithCopy, SHARED_FIELDS, SOURCE as SOURCE_PATH } from './system-one.mjs'

const SOURCE = 'export const BOUND_CAP_MS = 10_000\n'

test('names each mod whose copy of the client differs from the source, byte for byte', () => {
  const copies = [
    { mod: 'quick-reply', text: SOURCE.replace('10_000', '20_000') },
    { mod: 'whats-next', text: SOURCE },
    { mod: 'turn-chime', text: SOURCE.replace('\n', '\r\n') },
  ]
  assert.deepEqual(copyMismatches(SOURCE, copies), ['quick-reply', 'turn-chime'])
})

const FIELDS = {
  jevApiKey: { type: 'string', title: 'Jev API key', description: 'The key.', sensitive: true, default: '' },
  modelChoice: {
    type: 'string',
    title: 'System One models',
    description: 'Which System One model judges whether a turn finished the active step.',
    options: ['local only', 'local first', 'hosted first'],
    default: 'local only',
  },
  layaPort: { type: 'number', description: 'The port.', default: 8000 },
}

test('fields that match in name, type, sensitive, default and choices pass, whatever their descriptions say', () => {
  const other = structuredClone(FIELDS)
  other.modelChoice.description = 'Which System One model reads how an answer ends.'
  const manifests = [
    { mod: 'whats-next', userConfig: { skill: { type: 'string' }, ...FIELDS } },
    { mod: 'quick-reply', userConfig: other },
  ]
  assert.deepEqual(fieldMismatches(manifests), [])
})

test('layaPort may carry its own title, since no decision fixes it', () => {
  const other = structuredClone(FIELDS)
  other.layaPort.title = 'Port for Laya'
  const manifests = [
    { mod: 'whats-next', userConfig: { ...FIELDS, layaPort: { ...FIELDS.layaPort, title: 'Laya port' } } },
    { mod: 'quick-reply', userConfig: other },
  ]
  assert.deepEqual(fieldMismatches(manifests), [])
})

test('names the mod and the field when a System One field differs from the first mod or is missing', () => {
  const changed = (edit) => {
    const fields = structuredClone(FIELDS)
    edit(fields)
    return fields
  }
  const manifests = [
    { mod: 'whats-next', userConfig: FIELDS },
    { mod: 'a', userConfig: changed(fields => { fields.jevApiKey.sensitive = false }) },
    { mod: 'b', userConfig: changed(fields => { fields.layaPort.default = 8001 }) },
    { mod: 'c', userConfig: changed(fields => { fields.modelChoice.options = ['local only', 'hosted first', 'local first'] }) },
    { mod: 'd', userConfig: changed(fields => { fields.layaPort.type = 'string' }) },
    { mod: 'e', userConfig: changed(fields => { delete fields.layaPort }) },
    { mod: 'f', userConfig: changed(fields => { fields.modelChoice.title = 'Models' }) },
    { mod: 'g' },
  ]
  assert.deepEqual(fieldMismatches(manifests), [
    'a: jevApiKey differs from whats-next\'s',
    'b: layaPort differs from whats-next\'s',
    'c: modelChoice differs from whats-next\'s',
    'd: layaPort differs from whats-next\'s',
    'e: layaPort is missing',
    'f: modelChoice differs from whats-next\'s',
    'g: jevApiKey is missing',
    'g: modelChoice is missing',
    'g: layaPort is missing',
  ])
})

test('a mod that carries a copy but none of the fields is named even when it is the first', () => {
  assert.deepEqual(fieldMismatches([{ mod: 'whats-next', userConfig: {} }]), [
    'whats-next: jevApiKey is missing',
    'whats-next: modelChoice is missing',
    'whats-next: layaPort is missing',
  ])
})

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const read = path => readFileSync(join(ROOT, path), 'utf8')
const userConfig = mod => JSON.parse(read(join('mods', mod, '.claude-plugin', 'plugin.json'))).userConfig

test('quick-reply and whats-next carry the client byte for byte and declare its fields alike, and a drift in either is named', () => {
  assert.deepEqual(modsWithCopy(ROOT), ['quick-reply', 'whats-next'])
  const source = read(SOURCE_PATH)
  const copies = modsWithCopy(ROOT).map(mod => ({ mod, text: read(join('mods', mod, COPY)) }))
  assert.deepEqual(copyMismatches(source, copies), [])
  const manifests = modsWithCopy(ROOT).map(mod => ({ mod, userConfig: userConfig(mod) }))
  assert.deepEqual(fieldMismatches(manifests), [])

  for (const drifted of ['quick-reply', 'whats-next']) {
    const edited = copies.map(copy => (copy.mod === drifted ? { ...copy, text: `${copy.text}// drift\n` } : copy))
    assert.deepEqual(copyMismatches(source, edited), [drifted])
  }
  const [first, second] = manifests
  const portMoved = structuredClone(second)
  portMoved.userConfig.layaPort.default = 8001
  assert.deepEqual(fieldMismatches([first, portMoved]), [`${second.mod}: layaPort differs from ${first.mod}'s`])
  const choicesMoved = structuredClone(first)
  choicesMoved.userConfig.modelChoice.options = ['hosted first', 'local first', 'local only']
  assert.deepEqual(fieldMismatches([choicesMoved, second]), [`${second.mod}: modelChoice differs from ${first.mod}'s`])
})

test("quick-reply's modelChoice description says, word for word, what it sends (#128)", () => {
  assert.equal(
    userConfig('quick-reply').modelChoice.description,
    "Which System One model reads how each of Claude's answers ends, to choose the buttons. Local only: Laya on this machine, or the built-in reading as before. Local first: Laya, and TypeSafe's hosted Jev while Laya is unavailable. Hosted first: Jev, and Laya while Jev is unavailable. Jev receives the last 8,000 characters of every answer Claude gives and the labels of the choices found in it, once after each answered turn.",
  )
})

/** The README's entry for `mod`: from its heading to the next mod's. */
function readmeEntry(mod) {
  const readme = read('README.md')
  const start = readme.search(new RegExp(`^### \\S+ ${mod}$`, 'm'))
  assert.notEqual(start, -1, `README has no entry for ${mod}`)
  const end = readme.indexOf('\n### ', start + 1)
  return readme.slice(start, end === -1 ? undefined : end)
}

test('each mod carrying the client lists the three settings in its README entry, says what it sends to each model, and points at the steps for running Laya', () => {
  for (const mod of modsWithCopy(ROOT)) {
    const entry = readmeEntry(mod)
    for (const field of SHARED_FIELDS) assert.match(entry, new RegExp(`\`${field}\``), `${mod}: ${field}`)
    assert.match(entry, /\*\*To Jev,\*\*/, `${mod}: what goes to Jev`)
    assert.match(entry, /\*\*To Laya,\*\*/, `${mod}: what goes to Laya`)
    assert.match(entry, /\(#run-laya-for-these-mods\)/, `${mod}: the Laya steps`)
  }
})
