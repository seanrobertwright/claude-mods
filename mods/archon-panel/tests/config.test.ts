import { expect, test } from 'claude-code/testing'

import { parseConfig } from '../hooks/config'

test('settings are read at the boundary: a blank path finds the CLI, a bad port reads 3090, an unknown toasts reads all', () => {
  expect(parseConfig({})).toEqual({ archonPath: '', port: 3090, archonLog: '~/.archon/logs/serve.log', toasts: 'all', isStatusLine: true })
  expect(parseConfig({ archonPath: '   ' }).archonPath).toBe('')
  expect(parseConfig({ archonPath: ' D:\\tools\\archon.exe ' }).archonPath).toBe('D:\\tools\\archon.exe')
  for (const port of [0, 65536, 3090.5, -1, '3191']) expect(parseConfig({ archonPort: port }).port).toBe(3090)
  expect(parseConfig({ archonPort: 3191 }).port).toBe(3191)
  expect(parseConfig({ archonPort: 1 }).port).toBe(1)
  expect(parseConfig({ archonPort: 65535 }).port).toBe(65535)
  expect(parseConfig({ toasts: 'loud' }).toasts).toBe('all')
  expect(parseConfig({ toasts: 'needs you' }).toasts).toBe('needs you')
  expect(parseConfig({ toasts: 'off' }).toasts).toBe('off')
  expect(parseConfig({ statusLine: false }).isStatusLine).toBe(false)
  expect(parseConfig({ archonLog: '' }).archonLog).toBe('~/.archon/logs/serve.log')
})
