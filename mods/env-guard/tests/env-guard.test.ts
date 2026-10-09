import { expect, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { guardedIn, guardedName, parsePatterns } from '../hooks/guarded'

/** The keypick skill as the session's command list shows it. */
const KEYPICK = { name: 'keypick', description: 'Inject API keys into commands', source: 'user' } as const

/**
 * The world beneath the mod: what the person answers, the questions asked, the calls that got through and
 * the toasts shown. `landing` is the file system's links: each path and where it lands.
 */
type World = { answers: string[]; asked: string[]; ran: string[]; toasts: string[] }

function engineBeneath(
  on: On,
  { surfaces = ['terminal'], landing = {}, hasKeypick = false }: { surfaces?: readonly RenderSurface[]; landing?: Readonly<Record<string, string>>; hasKeypick?: boolean } = {},
): World {
  const world: World = { answers: [], asked: [], ran: [], toasts: [] }
  on('session.surfaces', () => ({ value: surfaces }))
  on('command.list', () => ({ value: hasKeypick ? [KEYPICK] : [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    // The engine hands the path over in the machine's own spelling; the test keeps one.
    const path = e.path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
    const realPath = Object.hasOwn(landing, path) ? landing[path] : undefined
    // A path that leads nowhere comes back without realPath, as the engine answers one it cannot resolve.
    return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: realPath !== undefined, ...(e.resolve && realPath !== undefined ? { realPath } : {}) } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    world.asked.push(question)
    const answer = world.answers.shift()
    // No answer left stands for the person dismissing the dialog.
    if (answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  on('tool.call', { tool: 'Read' }, (_$, e) => {
    world.ran.push(e.file_path)
    return { result: { type: 'text', file: { filePath: e.file_path, content: '', numLines: 0, startLine: 1, totalLines: 0 } } }
  })
  on('tool.call', { tool: 'Grep' }, (_$, e) => {
    world.ran.push(`Grep ${e.path ?? '.'} ${e.glob ?? ''} ${e.pattern}`)
    return { result: { numFiles: 0, filenames: [] } }
  })
  on('tool.call', { tool: 'Glob' }, (_$, e) => {
    world.ran.push(`Glob ${e.path ?? '.'} ${e.pattern}`)
    return { result: { durationMs: 0, numFiles: 0, filenames: [], truncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    world.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
    world.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return world
}

test('the built-in list guards .env files and keys, but not the templates of a .env nor a public key', () => {
  for (const path of ['.env', 'config/.env.local', 'deploy/server.pem', '~/.ssh/id_rsa', 'C:\\Users\\me\\.ssh\\id_ed25519', 'certs/CLIENT.P12', 'notes/../.ENV']) {
    expect(guardedName(path, [])).toBeDefined()
  }
  for (const path of ['.env.example', '.env.sample', 'app/.env.template', '~/.ssh/id_rsa.pub', 'id_ed25519.pub', '.envrc', 'environment.ts', '.key', 'notes/.env/..']) {
    expect(guardedName(path, [])).toBeUndefined()
  }
})

test('a glob names a guarded file as written or with its wildcards dropped', () => {
  expect(guardedName('**/.env', [])).toBe('.env')
  expect(guardedName('*.pem', [])).toBe('*.pem')
  expect(guardedName('.env*', [])).toBe('.env*')
  expect(guardedName('**/*.ts', [])).toBeUndefined()
})

test('the setting adds file-name globs and passes over a pattern with a folder, [ ] or { }', () => {
  const patterns = parsePatterns(' secrets.json, *.kdbx ,, config/app.json, [ab].txt, {app}.txt')
  expect(patterns.rejected).toEqual(['config/app.json', '[ab].txt', '{app}.txt'])
  expect(guardedName('vault/Passwords.KDBX', patterns.guarded)).toBe('Passwords.KDBX')
  expect(guardedName('secrets.json', patterns.guarded)).toBe('secrets.json')
  expect(guardedName('my-secrets.json', patterns.guarded)).toBeUndefined()
  expect(parsePatterns(undefined)).toEqual({ guarded: [], rejected: [] })
})

test('guardedIn finds a guarded file named anywhere in a shell command, each once', () => {
  for (const command of ['cat .env', 'type .env', 'Get-Content .env', 'grep KEY .env', 'Get-Content -Path .\\.env | Select-String KEY', 'bash -c "cat .env"', 'docker run --env-file=.env app', 'cat .env&&echo done']) {
    expect(guardedIn(command, [])).toEqual(['.env'])
  }
  expect(guardedIn('openssl x509 -in "My Keys/server.pem" && cat ~/.ssh/id_rsa .env .env', [])).toEqual(['server.pem', 'id_rsa', '.env'])
  expect(guardedIn('cp .env.example .env.local', [])).toEqual(['.env.local'])
  expect(guardedIn("jq '.key' package.json && cat ~/.ssh/id_rsa.pub", [])).toEqual([])
  expect(guardedIn('npm test', [])).toEqual([])
})

test('a Read of a .env or key file asks by name, and of a template or public key does not', async ($, on) => {
  const world = engineBeneath(on)
  for (const path of ['.env', 'config/.env.local', 'deploy/server.pem', '~/.ssh/id_rsa']) {
    world.answers.push('Allow once')
    await $.tool.call({ tool: 'Read', file_path: path })
  }
  expect(world.asked).toEqual(['Let Claude read .env?', 'Let Claude read .env.local?', 'Let Claude read server.pem?', 'Let Claude read id_rsa?'])
  await $.tool.call({ tool: 'Read', file_path: '.env.example' })
  await $.tool.call({ tool: 'Read', file_path: '~/.ssh/id_rsa.pub' })
  expect(world.asked.length).toBe(4)
  expect(world.ran.length).toBe(6)
})

test('a shell command that names a guarded file asks, in Bash and in PowerShell', async ($, on) => {
  const world = engineBeneath(on)
  await $.tool.call({ tool: 'Bash', command: 'cat .env' })
  await $.tool.call({ tool: 'Bash', command: 'grep KEY .env' })
  await $.tool.call({ tool: 'PowerShell', command: 'type .env' })
  await $.tool.call({ tool: 'PowerShell', command: 'Get-Content .env' })
  expect(world.asked).toEqual(Array(4).fill('Let Claude read .env?'))
  expect(world.ran).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(world.asked.length).toBe(4)
  expect(world.ran).toEqual(['npm test'])
})

test('a path is judged where it leads: .. is folded and a link is followed', async ($, on) => {
  const world = engineBeneath(on, { landing: { '/work/app/settings.txt': '/work/app/.env' } })
  const climbed = await $.tool.call({ tool: 'Read', file_path: '/work/app/notes/../.env' })
  const linked = await $.tool.call({ tool: 'Read', file_path: '/work/app/settings.txt' })
  expect(world.asked).toEqual(['Let Claude read .env?', 'Let Claude read .env?'])
  expect(climbed.deny).toContain('holds secrets')
  expect(linked.deny).toContain('holds secrets')
  expect(world.ran).toEqual([])
})

test('Grep and Glob ask for a guarded path searched or a filter that names a guarded file, and not for a folder', async ($, on) => {
  const world = engineBeneath(on)
  await $.tool.call({ tool: 'Grep', pattern: 'KEY', path: 'config/.env.local' })
  await $.tool.call({ tool: 'Grep', pattern: 'BEGIN', glob: '*.pem' })
  await $.tool.call({ tool: 'Glob', pattern: '**/.env' })
  expect(world.asked).toEqual(['Let Claude read .env.local?', 'Let Claude read *.pem?', 'Let Claude read .env?'])

  // Grep's own pattern is a regex, not a path, and a folder is searched whatever it holds.
  await $.tool.call({ tool: 'Grep', pattern: '.env', path: 'src' })
  await $.tool.call({ tool: 'Glob', pattern: '**/*.ts' })
  expect(world.asked.length).toBe(3)
  expect(world.ran).toEqual(['Grep src  .env', 'Glob . **/*.ts'])
})

test('a pattern added in the setting is guarded', { options: { extraPatterns: 'secrets.json, *.kdbx' } }, async ($, on) => {
  const world = engineBeneath(on)
  await $.tool.call({ tool: 'Read', file_path: 'config/secrets.json' })
  await $.tool.call({ tool: 'Bash', command: 'keepassxc-cli ls vault.kdbx' })
  expect(world.asked).toEqual(['Let Claude read secrets.json?', 'Let Claude read vault.kdbx?'])
})

test('a malformed pattern in the setting is named once, at the first turn of a shown session', { options: { extraPatterns: 'secrets.json, config/app.json' } }, async ($, on) => {
  const world = engineBeneath(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toContain('"config/app.json"')
  await $.tool.call({ tool: 'Read', file_path: 'secrets.json' })
  expect(world.asked).toEqual(['Let Claude read secrets.json?'])
})

test('"Allow once" lets that one call through, and the next read of the file asks again', async ($, on) => {
  const world = engineBeneath(on)
  world.answers.push('Allow once')
  const allowed = await $.tool.call({ tool: 'Read', file_path: '.env' })
  expect(allowed.deny).toBeUndefined()
  expect(world.ran).toEqual(['.env'])

  world.answers.push('Refuse')
  const refused = await $.tool.call({ tool: 'Read', file_path: '.env' })
  expect(world.asked.length).toBe(2)
  expect(refused.deny).toBe('env-guard: the person did not let Claude read .env, which holds secrets.')
  expect(world.ran).toEqual(['.env'])
})

test('a dismissed question refuses the call', async ($, on) => {
  const world = engineBeneath(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'cat .env deploy/server.pem' })
  expect(world.asked).toEqual(['Let Claude read .env and server.pem?'])
  expect(ran.deny).toBe('env-guard: the person did not let Claude read .env and server.pem, which hold secrets.')
  expect(world.ran).toEqual([])
})

test('the refusal points to keypick when the keypick skill is installed', async ($, on) => {
  const world = engineBeneath(on, { hasKeypick: true })
  world.answers.push('Refuse')
  const ran = await $.tool.call({ tool: 'Read', file_path: '.env' })
  expect(ran.deny).toContain('which holds secrets.')
  expect(ran.deny).toContain('use the keypick skill instead')
  expect(world.ran).toEqual([])
})

test('the refusal does not name keypick when it is not installed', async ($, on) => {
  const world = engineBeneath(on)
  world.answers.push('Refuse')
  const ran = await $.tool.call({ tool: 'Read', file_path: '.env' })
  expect(ran.deny).not.toContain('keypick')
})

test('in a headless session a guarded read is refused without a question', async ($, on) => {
  const world = engineBeneath(on, { surfaces: [], hasKeypick: true })
  const read = await $.tool.call({ tool: 'Read', file_path: '.env' })
  const shell = await $.tool.call({ tool: 'Bash', command: 'cat .env' })
  expect(world.asked).toEqual([])
  expect(read.deny).toContain('env-guard: .env holds secrets, and in this session no one is there to let Claude read it.')
  expect(read.deny).toContain('keypick')
  expect(shell.deny).toContain('holds secrets')
  expect(world.ran).toEqual([])

  // Anything else goes on as it would without the mod.
  await $.tool.call({ tool: 'Read', file_path: 'README.md' })
  expect(world.ran).toEqual(['README.md'])
})
