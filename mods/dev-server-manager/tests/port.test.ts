import { expect, test } from 'claude-code/testing'

import { holderWords, parseLsof, parseNetstat, parseSs, parseTasklist } from '../hooks/port'

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:5173         127.0.0.1:50122        TIME_WAIT       0
  TCP    127.0.0.1:15173        0.0.0.0:0              LISTENING       77
  TCP    [::1]:5173             [::]:0                 ABHÖREN         41236
  TCP    127.0.0.1:6006         0.0.0.0:0              LISTENING       18244
  TCP    0.0.0.0:6006           0.0.0.0:0              LISTENING       5100
  TCP    [::1]:6006             [::1]:50133            ESTABLISHED     18244
  UDP    0.0.0.0:5173           *:*                                    999
`

test('netstat: a listener on the port on any address, IPv4 or IPv6, in any language', () => {
  expect(parseNetstat(NETSTAT, 5173)).toEqual([41236])
  expect(parseNetstat(NETSTAT, 6006)).toEqual([18244, 5100])
  expect(parseNetstat(NETSTAT, 3000)).toEqual([])
})

test('netstat: TIME_WAIT rows and PID 0 are no holder', () => {
  expect(parseNetstat('  TCP    [::1]:4000    [::1]:5000    TIME_WAIT    0\n  TCP    0.0.0.0:4000    0.0.0.0:0    LISTENING    0\n', 4000)).toEqual([])
})

test('ss names the holder; a row without users is still taken', () => {
  expect(parseSs('LISTEN 0 128 [::1]:5173 [::]:* users:(("node",pid=812,fd=3))\n')).toEqual([{ name: 'node', pid: 812 }])
  expect(parseSs('LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*\n')).toEqual([{ name: '', pid: 0 }])
  expect(parseSs('')).toEqual([])
})

test('lsof gives the command and the PID of each listener', () => {
  const text = 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    41236 me    23u  IPv6 0x1      0t0  TCP [::1]:5173 (LISTEN)\n'
  expect(parseLsof(text)).toEqual([{ name: 'node', pid: 41236 }])
  expect(parseLsof('')).toEqual([])
})

test('tasklist names a PID; a gone PID names nothing', () => {
  expect(parseTasklist('"node.exe","18244","Console","1","37,592 K"\r\n')).toBe('node.exe')
  expect(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n')).toBe('')
})

test('the row words name the holder when known, PID 4 as System, and leave it out when not', () => {
  expect(holderWords(6006, { name: 'node.exe', pid: 18244 })).toBe(':6006 taken by node.exe 18244')
  expect(holderWords(80, { name: '', pid: 4 })).toBe(':80 taken by System 4')
  expect(holderWords(5432, { name: '', pid: 0 })).toBe(':5432 taken')
  expect(holderWords(5432, { name: '', pid: 900 })).toBe(':5432 taken')
})
