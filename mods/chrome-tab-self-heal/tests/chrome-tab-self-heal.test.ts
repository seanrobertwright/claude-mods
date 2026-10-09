import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HINT = 'Call tabs_context_mcp for the current tab IDs, then retry with one of them.'

/** The claude-in-chrome server beneath the mod, answering every call with an error of the text it holds. */
function serverBeneath(on: On, error: string): { error: string } {
  const server = { error }
  on('tool.call', { tool: /^mcp__claude-in-chrome__/ }, () => ({ isError: true, result: server.error, text: server.error }))
  return server
}

test('an error saying the tab no longer exists keeps its text and gets the hint', async ($, on) => {
  serverBeneath(on, 'Tab 1786443 no longer exists')
  const ran = await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', tabId: 1786443, url: 'example.com' })
  expect(ran.isError).toBe(true)
  expect(ran.text).toBe('Tab 1786443 no longer exists')
  expect(ran.context).toEqual([HINT])
})

test('an error saying there is no tab with that ID keeps its text and gets the hint', async ($, on) => {
  serverBeneath(on, 'No tab with id: 1786443.')
  const ran = await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', tabId: 1786443, action: 'screenshot' })
  expect(ran.text).toBe('No tab with id: 1786443.')
  expect(ran.context).toEqual([HINT])
})

test('an error saying the tab ID is invalid keeps its text and gets the hint', async ($, on) => {
  serverBeneath(on, 'Invalid tab ID: 1786443')
  const ran = await $.tool.call({ tool: 'mcp__claude-in-chrome__read_page', tabId: 1786443 })
  expect(ran.text).toBe('Invalid tab ID: 1786443')
  expect(ran.context).toEqual([HINT])
})

test('other errors of the server pass unchanged, a gone element or tab group among them', async ($, on) => {
  const others = [
    "Element with ref_id 'ref_12' no longer exists. It may have been removed from the page. Use read_page without ref_id to get the current page state.",
    "This session's tab group no longer exists. Call tabs_context_mcp first to re-establish context.",
    'Navigation timed out after 30000ms',
  ]
  const server = serverBeneath(on, '')
  for (const text of others) {
    server.error = text
    const ran = await $.tool.call({ tool: 'mcp__claude-in-chrome__find', tabId: 1786443, query: 'the search box' })
    expect(ran.text).toBe(text)
    expect(ran.context).toBeUndefined()
  }
})

test('a successful result passes unchanged, even when the page it read says a tab no longer exists', async ($, on) => {
  const answer = { result: 'Help: what to do when a tab no longer exists', text: 'Help: what to do when a tab no longer exists' }
  on('tool.call', { tool: 'mcp__claude-in-chrome__get_page_text' }, () => answer)
  const ran = await $.tool.call({ tool: 'mcp__claude-in-chrome__get_page_text', tabId: 1786443 })
  expect(ran).toEqual(answer)
})

test("another server's tool passes unchanged, whatever its error says", async ($, on) => {
  const answer = { isError: true as const, result: 'No tab with id: 7.', text: 'No tab with id: 7.' }
  on('tool.call', { tool: 'mcp__playwright__browser_navigate' }, () => answer)
  const ran = await $.tool.call({ tool: 'mcp__playwright__browser_navigate', url: 'example.com' })
  expect(ran).toEqual(answer)
})

test('the hint is added once, and what the model was already to read after the error is kept', async ($, on) => {
  const note = 'The page was slow to load.'
  on('tool.call', { tool: /^mcp__claude-in-chrome__/ }, () => ({
    isError: true,
    result: 'Tab 1786443 no longer exists',
    text: 'Tab 1786443 no longer exists',
    context: [note, HINT],
  }))
  const ran = await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', tabId: 1786443, url: 'example.com' })
  expect(ran.context).toEqual([note, HINT])
})
