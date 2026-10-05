import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GitHubView } from '../types'
import {
  ago,
  blockerLines,
  fit,
  ISSUE_FIELDS,
  issueDetail,
  missingRequirement,
  NEEDS_GH,
  parseConfig,
  parseIssues,
  parsePrs,
  PR_FIELDS,
  prDetail,
} from './parse'
import type { Config } from './parse'

const PANE = 'github'
const TITLE = 'GitHub'
/** After a turn, refresh only when the lists are older than this. */
const AFTER_TURN_MS = 60_000

const EMPTY: GitHubView = { status: 'idle', repo: '', prs: [], issues: [], error: '', updatedAt: 0, runId: 0 }
const view = atom({ plugin: 'github-panel', key: 'view' } as const, EMPTY)
const hasStartedUp = atom({ plugin: 'github-panel', key: 'hasStartedUp' } as const, false)

// Dies with the module on a reload; session.start or the next attach starts it again.
let every: Timer | undefined
// Counts attaches, so a surfaces check answered before an attach cannot stop
// the polling that attach kept going.
let attaches = 0

/**
 * Whether any surface shows the session right now. Asked before each action
 * the mod starts on its own and never kept: a reload or a missed attach would
 * leave a kept flag wrong. Each mod carries its own copy (ADR-0001).
 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

function stopPolling(): void {
  every?.cancel()
  every = undefined
}

/** Refreshes on the configured interval; a tick that finds no surface stops it until the next attach. */
function startPolling($: EngineInterface, config: Config): void {
  stopPolling()
  if (config.refreshMs <= 0) return
  const own = $.clock.every(config.refreshMs, () => {
    void (async () => {
      // A missing requirement waits for r or /github, as after a turn.
      const seen = attaches
      if (!(await isShown($))) {
        if (every === own && attaches === seen) stopPolling()
      } else if ((await read($, view)).status !== 'unavailable') await load($, config)
    })().catch(report($))
  })
  every = own
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`GitHub: ${error instanceof Error ? error.message : String(error)}`)
}

function lastLine(output: string): string {
  const lines = output.trim().split(/\r?\n/)
  return lines[lines.length - 1]?.slice(0, 200) ?? ''
}

/** Runs gh; a gh that cannot start (not installed) rejects with a message that says so. */
async function gh($: EngineInterface, args: readonly string[]) {
  try {
    return await $.process.run(['gh', ...args])
  } catch (error) {
    throw new Error(`could not run gh (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
}

/** Whether gh starts at all: a fast call with no network, to tell a missing gh from a slow one. */
async function canStartGh($: EngineInterface): Promise<boolean> {
  try {
    await gh($, ['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * Loads the open PRs and issues of the session's repo. One load at a time;
 * a load superseded by a reload of the module is dropped by its runId.
 * A missing requirement (gh, its login, a GitHub remote) leaves the view
 * `unavailable` with a message naming it and the fix.
 */
async function load($: EngineInterface, config: Config): Promise<void> {
  let runId = 0
  await update($, view, (current): GitHubView => {
    if (current.status === 'loading') {
      runId = 0
      return current
    }
    runId = current.runId + 1
    return { ...current, status: 'loading', error: '', runId }
  })
  if (runId === 0) return

  const finish = (change: (current: GitHubView) => GitHubView) =>
    update($, view, current => (current.runId === runId ? change(current) : current))

  const unavailable = (reason: string) =>
    finish(current => ({ ...current, status: 'unavailable', error: reason, repo: '', prs: [], issues: [], updatedAt: 0 }))

  try {
    let repo
    try {
      repo = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    } catch (error) {
      if (!(await canStartGh($))) return void (await unavailable(NEEDS_GH))
      throw error
    }
    if (repo.exitCode !== 0) {
      const missing = missingRequirement(repo.exitCode, repo.stderr)
      if (missing === undefined) throw new Error(lastLine(repo.stderr) || `gh exited with ${repo.exitCode}`)
      await unavailable(missing)
      return
    }
    const limit = String(config.limit)
    const [prs, issues] = await Promise.all([
      gh($, ['pr', 'list', '--state', 'open', '--limit', limit, '--json', PR_FIELDS]),
      gh($, ['issue', 'list', '--state', 'open', '--limit', limit, '--json', ISSUE_FIELDS]),
    ])
    const failed = [prs, issues].find(run => run.exitCode !== 0)
    if (failed !== undefined) throw new Error(lastLine(failed.stderr) || `gh exited with ${failed.exitCode}`)
    const updatedAt = await $.clock.now()
    const next = { repo: repo.stdout.trim(), prs: parsePrs(prs.stdout), issues: parseIssues(issues.stdout), updatedAt }
    await finish(current => ({ ...current, ...next, status: 'idle', error: '' }))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await finish(current => ({ ...current, status: 'error', error: reason }))
  }
}

/**
 * The start-up work: loads the lists, then opens the pane unasked when
 * `isPaneWanted` and the load came back: not while a requirement is missing
 * (`unavailable`), nor while another load is still running (`loading`).
 * Otherwise the pane waits for /github.
 */
async function startUp($: EngineInterface, config: Config, isPaneWanted: boolean): Promise<void> {
  await load($, config)
  const { status } = await read($, view)
  if (isPaneWanted && status !== 'unavailable' && status !== 'loading') await $.ui.open({ id: PANE, title: TITLE })
}

/** Opens a PR, an issue, or a whole list in the browser through gh. */
async function openOnGitHub($: EngineInterface, args: readonly string[]): Promise<void> {
  const run = await gh($, [...args, '--web'])
  if (run.exitCode !== 0) $.ui.toast(`GitHub: ${lastLine(run.stderr) || 'could not open the browser'}`)
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'github', description: 'Open the GitHub pane in the side panel: open PRs and issues' })
    // A reload killed any load in flight: drop its loading state and its result.
    await update($, view, (current): GitHubView => ({
      ...current,
      status: current.status === 'loading' ? 'idle' : current.status,
      runId: current.runId + 1,
    }))
    stopPolling()
    // A headless session does nothing until a surface attaches (session.attach).
    if (await isShown($)) {
      startPolling($, config)
      await update($, hasStartedUp, () => true)
      void startUp($, config, true).catch(report($))
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    attaches += 1
    const done = await next(e)
    if (every === undefined) startPolling($, config)
    let isFirst = false
    await update($, hasStartedUp, was => {
      isFirst = !was
      return true
    })
    // A session that started headless catches up once. The pane opens unasked
    // only on a surface that docks it beside the conversation; elsewhere, such as
    // on a phone, it waits for /github.
    if (isFirst) void startUp($, config, e.viewport?.isFullscreen === true).catch(report($))
    return done
  })

  on('session.detach', async ($, e, next) => {
    const seen = attaches
    const done = await next(e)
    if (!(await isShown($)) && attaches === seen) stopPolling()
    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || !(await isShown($))) return done
    const current = await read($, view)
    if (current.status !== 'unavailable' && (await $.clock.now()) - current.updatedAt > AFTER_TURN_MS) {
      void load($, config).catch(report($))
    }
    return done
  })

  on('command.run', { command: 'github' }, async $ => {
    // Focus brings the pane in front of another mod's tab; an open pane would only be retitled
    // without it. The open at start never asks it, so the mod takes the keyboard only when asked.
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void load($, config).catch(report($))
    return { text: 'GitHub pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, view)
    const now = await $.clock.now()
    const width = Math.max(16, e.props.bodyColumns)
    const room = width - 1
    const isFull = (count: number) => count >= config.limit

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">{current.repo === '' ? TITLE : current.repo}</Text>
          <Button key="refresh" plain dimColor hotkey="r" label="refresh" onPress={() => void load($, config).catch(report($))} />
        </Box>
        {current.status === 'loading' && <Text dimColor>Loading{'…'}</Text>}
        {(current.status === 'error' || current.status === 'unavailable') && (
          <Text color="red" wrap="wrap">{current.error}</Text>
        )}
        {current.status !== 'loading' && current.updatedAt > 0 && <Text dimColor>updated {ago(now - current.updatedAt)}</Text>}

        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Text bold>Pull requests {current.prs.length}{isFull(current.prs.length) ? '+' : ''}</Text>
          {current.repo !== '' && (
            <Button key="all-prs" plain dimColor label="all" onPress={() => void openOnGitHub($, ['pr', 'list']).catch(report($))} />
          )}
        </Box>
        {current.prs.length === 0 && current.updatedAt > 0 && <Text dimColor>No open pull requests.</Text>}
        {current.prs.map(pr => (
          <Box key={`pr-row-${pr.number}`} flexDirection="column">
            <Button
              key={`pr-${pr.number}`}
              plain
              label={fit(`#${pr.number} ${pr.title}`, room)}
              onPress={() => void openOnGitHub($, ['pr', 'view', String(pr.number)]).catch(report($))}
            />
            {prDetail(pr) !== '' && <Text dimColor wrap="truncate-end">  {prDetail(pr)}</Text>}
          </Box>
        ))}

        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Text bold>Issues {current.issues.length}{isFull(current.issues.length) ? '+' : ''}</Text>
          {current.repo !== '' && (
            <Button key="all-issues" plain dimColor label="all" onPress={() => void openOnGitHub($, ['issue', 'list']).catch(report($))} />
          )}
        </Box>
        {current.issues.length === 0 && current.updatedAt > 0 && <Text dimColor>No open issues.</Text>}
        {current.issues.map(issue => {
          const isBlocked = issue.blockedBy.length > 0
          const label = fit(`#${issue.number} ${issue.title}`, room)
          const open = () => void openOnGitHub($, ['issue', 'view', String(issue.number)]).catch(report($))
          // A Button's label takes no color at rest, so a blocked issue's detail line is the red one.
          return (
            <Box key={`issue-row-${issue.number}`} flexDirection="column">
              {isBlocked
                ? <Button key={`issue-${issue.number}`} plain label={label} hover={{ color: 'red' }} onPress={open} />
                : <Button key={`issue-${issue.number}`} plain label={label} onPress={open} />}
              {issueDetail(issue) !== '' && (isBlocked
                ? <Text color="red" wrap="truncate-end">  {issueDetail(issue)}</Text>
                : <Text dimColor wrap="truncate-end">  {issueDetail(issue)}</Text>)}
              {isBlocked && (
                <Box
                  position="absolute"
                  top={2}
                  left={2}
                  width={width - 2}
                  display="none"
                  hover={{ display: 'flex' }}
                  borderStyle="round"
                  borderColor="red"
                >
                  <Text>{blockerLines(issue.blockedBy, width - 4).join('\n')}</Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
