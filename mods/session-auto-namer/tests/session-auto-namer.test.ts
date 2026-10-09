import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

const NAME = { key: 'name' }
const DISMISS = { key: 'dismiss' }

/**
 * The engine beneath the mod: a session shown on the terminal (or on no surface
 * with `isHeadless`), `turns` prompts already in its transcript, and gh answering
 * each `gh api repos/<owner>/<repo>/issues/<n>` from `titles` and failing the rest.
 * Each command run, prompt sent and gh call is logged.
 */
function desk(on: On, setup: { titles?: Record<string, string>; turns?: number; isHeadless?: boolean } = {}): string[] {
  const log: string[] = []
  let turns = setup.turns ?? 0
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: setup.isHeadless === true ? [] : ['terminal'] }))
  on('session.turns', () => ({ value: turns }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => {
    turns += 1
    return { text: e.text }
  })
  on('command.run', (_$, e) => {
    log.push(`/${e.command} ${e.args}`)
    return { text: '' }
  })
  on('process.run', (_$, e) => {
    log.push(e.argv.join(' '))
    const title = e.argv[0] === 'gh' ? setup.titles?.[e.argv.at(-1) ?? ''] : undefined
    return title === undefined
      ? { value: { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: `${title}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return log
}

async function submit($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

/** The name button's text in a freshly mounted band, or undefined when there is none. */
async function suggested($: Engine): Promise<string | undefined> {
  const band = await $.ui.mount({ plugin: 'session-auto-namer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const found = await band.find(NAME)
  await band.unmount()
  return found?.text
}

test('a first slash command suggests its name without the plugin, then the first words of its arguments', async ($, on) => {
  desk(on)
  await submit($, '/gsd:plan-phase 3 for the router rewrite and its tests')
  expect(await suggested($)).toBe('Name: plan-phase 3 for the router rewrite')
})

test('a first prompt that is no command suggests its first words', async ($, on) => {
  desk(on)
  await submit($, 'fix the flaky login test on windows please')
  expect(await suggested($)).toBe('Name: fix the flaky login test')
})

test('a later prompt gets no suggestion of its own', async ($, on) => {
  desk(on)
  await submit($, 'fix the flaky login test on windows please')
  await submit($, '/review now look at the other failing tests')
  expect(await suggested($)).toBe('Name: fix the flaky login test')
})

test('a resumed session, whose transcript already holds prompts, gets no suggestion', async ($, on) => {
  desk(on, { turns: 3 })
  await submit($, 'fix the flaky login test on windows please')
  expect(await suggested($)).toBeUndefined()
})

test('a /clear starts a fresh session: the old suggestion goes and its first prompt gets one', async ($, on) => {
  desk(on)
  await submit($, 'fix the flaky login test on windows please')
  // The transcript's count of prompts does not start again after a /clear.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(await suggested($)).toBeUndefined()

  await submit($, '/wayfinder chart the release work')
  expect(await suggested($)).toBe('Name: wayfinder chart the release work')
  await submit($, 'and the docs too')
  expect(await suggested($)).toBe('Name: wayfinder chart the release work')
})

test('a press renames the session and takes the button down; nothing is renamed before it', async ($, on) => {
  const log = desk(on)
  await submit($, '/gsd:plan-phase 3 for the router rewrite and its tests')
  await submit($, 'go on')
  expect(log.filter(line => line.startsWith('/rename'))).toEqual([])

  const band = await $.ui.mount({ plugin: 'session-auto-namer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press(NAME)
  expect(log.filter(line => line.startsWith('/rename'))).toEqual(['/rename plan-phase 3 for the router rewrite'])
  expect(await band.find(NAME)).toBeUndefined()
  expect(await band.find(DISMISS)).toBeUndefined()
  await band.unmount()
})

test('dismiss takes the button down without renaming', async ($, on) => {
  const log = desk(on)
  await submit($, 'fix the flaky login test on windows please')

  const band = await $.ui.mount({ plugin: 'session-auto-namer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press(DISMISS)
  expect(await band.find(NAME)).toBeUndefined()
  await band.unmount()
  expect(await suggested($)).toBeUndefined()
  expect(log.filter(line => line.startsWith('/rename'))).toEqual([])
})

test('in a headless session nothing is suggested and gh is not started', async ($, on) => {
  const log = desk(on, { isHeadless: true, titles: { 'repos/{owner}/{repo}/issues/53': 'Add a drift check' } })
  await submit($, '/implement #53')
  expect(await suggested($)).toBeUndefined()
  expect(log).toEqual([])
})

const TITLES = {
  'repos/owner/repo/issues/53': 'Add a drift check',
  'repos/owner/repo/issues/7': 'Bring the asked pane to the front',
  'repos/{owner}/{repo}/issues/41': 'Name the mods in the README',
}

test("an issue's link suggests its number and its title from gh, started by bare name", async ($, on) => {
  const log = desk(on, { titles: TITLES })
  await submit($, '/implement https://github.com/owner/repo/issues/53')
  expect(await suggested($)).toBe('Name: #53 Add a drift check')
  expect(log).toEqual(['gh api --jq .title repos/owner/repo/issues/53'])
})

test("a pull request's link, or #N in the session's repo, suggests its number and title", async ($, on) => {
  desk(on, { titles: TITLES })
  await submit($, 'review https://github.com/owner/repo/pull/7 before the release')
  expect(await suggested($)).toBe('Name: #7 Bring the asked pane to the front')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await submit($, '/wayfinder #41')
  expect(await suggested($)).toBe('Name: #41 Name the mods in the README')
})

test('an issue gh cannot read gives the other rules', async ($, on) => {
  desk(on, { titles: TITLES })
  await submit($, '/implement #99 the cache fix')
  expect(await suggested($)).toBe('Name: implement #99 the cache fix')
})

test('a milestone and a step suggest them with the command, its last word capitalised', async ($, on) => {
  desk(on)
  await submit($, '/gsd:execute-phase M12 S4 with the new parser')
  expect(await suggested($)).toBe('Name: M12 - S4 - Execute-phase')
})

test('a milestone and a step with no command suggest the two alone; one of them alone does not count', async ($, on) => {
  desk(on)
  await submit($, 'carry on with M3 S1 from yesterday')
  expect(await suggested($)).toBe('Name: M3 - S1')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await submit($, '/gsd:plan-phase M3 only')
  expect(await suggested($)).toBe('Name: plan-phase M3 only')
})
