import assert from 'node:assert/strict'
import { test } from 'node:test'

import { copyMismatches, fieldMismatches } from './system-one.mjs'

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
