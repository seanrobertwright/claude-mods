import { expect, test } from 'claude-code/testing'

import { parseAdd } from '../hooks/add'

const NONE = { detected: [], added: [] }

test('add splits the command on spaces and quotes, the mod options before it', () => {
  expect(parseAdd('api --port 8000 --cwd backend uv run uvicorn app:main --port 8000', NONE)).toEqual({
    server: { name: 'api', port: 8000, cwd: 'backend', argv: ['uv', 'run', 'uvicorn', 'app:main', '--port', '8000'] },
  })
  expect(parseAdd(`docs  python -m http.server "8 0" 'a b'`, NONE)).toEqual({
    server: { name: 'docs', argv: ['python', '-m', 'http.server', '8 0', 'a b'] },
  })
})

test('an option after the command is the command own flag', () => {
  expect(parseAdd('web vite --port 5173 --cwd x', NONE)).toEqual({
    server: { name: 'web', argv: ['vite', '--port', '5173', '--cwd', 'x'] },
  })
})

test('shell syntax outside quotes is refused with a reply that says why', () => {
  for (const command of ['a && b', 'a || b', 'a | b', 'a; b', 'a > log', 'a < in', 'a `b`', 'a $(b)', 'NODE_ENV=dev vite', 'a&&b']) {
    const parsed = parseAdd(`web ${command}`, NONE)
    expect('error' in parsed && parsed.error, command).toMatch(/without a shell/)
    expect('error' in parsed && parsed.error, command).toMatch(/package\.json script/)
  }
  expect(parseAdd('web node -e "a && b; c > d"', NONE)).toEqual({ server: { name: 'web', argv: ['node', '-e', 'a && b; c > d'] } })
})

test('a name already in use, detected or added, is refused and named', () => {
  const taken = { detected: ['dev'], added: ['api'] }
  expect(parseAdd('dev vite', taken)).toEqual({ error: 'dev is already a server here (a package.json script). Pick another name.' })
  expect(parseAdd('api vite', taken)).toEqual({ error: 'api is already a server here (added with /dev-servers add). Pick another name.' })
})

test('add without a command, a bad port or an unclosed quote says how to use it', () => {
  expect(parseAdd('web', NONE)).toMatchObject({ error: expect.stringContaining('/dev-servers add <name> [--port N] [--cwd dir] <command…>') })
  expect(parseAdd('web --port abc vite', NONE)).toMatchObject({ error: expect.stringContaining('--port') })
  expect(parseAdd('web vite "open', NONE)).toMatchObject({ error: expect.stringContaining('quote') })
})
