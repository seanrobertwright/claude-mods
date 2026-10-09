import { expect, test } from 'claude-code/testing'

import type { OutputLine } from '../types'
import { errorLines, errorPrompt, findLocalUrl, keep, splitPiece, stripAnsi } from '../hooks/output'

test('pieces become whole lines: one line over two pieces, several lines in one, CRLF', () => {
  let pending = ''
  const lines: string[] = []
  for (const piece of ['  ➜  Local:   http://local', 'host:5173/\n  ➜  Network: use --host\r\nready', ' in 300 ms\r\n']) {
    const split = splitPiece(pending, piece)
    pending = split.rest
    lines.push(...split.lines)
  }
  expect(lines).toEqual(['  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host', 'ready in 300 ms'])
  expect(pending).toBe('')
})

test('a URL coloured mid-port is found once ANSI is stripped', () => {
  const line = stripAnsi('  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5199\x1b[22m/\x1b[39m')
  expect(line).toBe('  ➜  Local:   http://localhost:5199/')
  expect(findLocalUrl(line)).toEqual({ url: 'http://localhost:5199', port: 5199 })
})

test('the loopback URL is taken, never a Network one; uvicorn and Django lines match', () => {
  expect(findLocalUrl('- Network: http://100.64.1.2:5198')).toBeUndefined()
  expect(findLocalUrl('- Local:         http://localhost:5198')).toEqual({ url: 'http://localhost:5198', port: 5198 })
  expect(findLocalUrl('INFO:     Uvicorn running on http://127.0.0.1:5196 (Press CTRL+C to quit)')).toEqual({ url: 'http://127.0.0.1:5196', port: 5196 })
  expect(findLocalUrl('Starting WSGI development server at http://[::1]:8000/')).toEqual({ url: 'http://[::1]:8000', port: 8000 })
  expect(findLocalUrl('listening on https://0.0.0.0:8443')).toEqual({ url: 'https://localhost:8443', port: 8443 })
})

function line(seq: number, text: string, stream: OutputLine['stream'] = 'stdout'): OutputLine {
  return { seq, stream, text, at: 0 }
}

test('the kept list holds the last 500 lines, dividers counted, each cut at 2,000 characters', () => {
  let list: OutputLine[] = []
  for (let n = 0; n < 300; n += 1) list = keep(list, [line(n, `a${n}`)])
  list = keep(list, [line(300, '── crashed (exit 3) · restarted 14:02 ──', 'divider')])
  for (let n = 301; n < 601; n += 1) list = keep(list, [line(n, 'x'.repeat(n === 600 ? 2500 : 1))])
  expect(list).toHaveLength(500)
  expect(list[0]?.text).toBe('a101')
  expect(list.some(kept => kept.stream === 'divider')).toBe(true)
  expect(list[499]?.text).toBe(`${'x'.repeat(2000)}…`)
})

test('the error is the last 40 lines since the last divider, capped at 4,000 characters from the top', () => {
  const before = Array.from({ length: 5 }, (_, n) => line(n, `old ${n}`))
  const run = Array.from({ length: 60 }, (_, n) => line(100 + n, `line ${n}`, n % 2 === 0 ? 'stdout' : 'stderr'))
  const list = [...before, line(50, '── restarted 14:02 ──', 'divider'), ...run]
  const lines = errorLines(list)
  expect(lines).toHaveLength(40)
  expect(lines[0]).toBe('line 20')
  expect(lines[39]).toBe('line 59')

  const long = Array.from({ length: 40 }, (_, n) => line(n, `${n}:${'y'.repeat(198)}`))
  const cut = errorLines(long)
  expect(cut.join('\n').length).toBeLessThanOrEqual(4000)
  expect(cut[cut.length - 1]).toStartWith('39:')
  expect(cut[0]).not.toStartWith('0:')
})

test('the error prompt: a header, then the lines in a fence; a silent run says so', () => {
  const at = new Date(2026, 9, 9, 14, 2).getTime()
  const death = { at, code: 3, signal: null, command: 'npm run dev', lines: ['Error: boom', '    at main.js:1'] }
  expect(errorPrompt('web', death)).toBe(
    'The dev server web (npm run dev) crashed with exit 3 at 14:02. Its last output:\n\n```\nError: boom\n    at main.js:1\n```',
  )
  expect(errorPrompt('web', { ...death, lines: [] })).toBe(
    'The dev server web (npm run dev) crashed with exit 3 at 14:02. It printed nothing before it exited.',
  )
  expect(errorPrompt('web', { ...death, code: null, signal: 'SIGKILL', lines: ['```'] })).toBe(
    'The dev server web (npm run dev) crashed with signal SIGKILL at 14:02. Its last output:\n\n````\n```\n````',
  )
})
