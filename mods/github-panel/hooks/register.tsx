import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GitHubView } from '../types'
import { ago, fit, ISSUE_FIELDS, issueDetail, parseConfig, parseIssues, parsePrs, PR_FIELDS, prDetail } from './parse'
import type { Config } from './parse'

const PANE = 'github'
const TITLE = 'GitHub'
/** After a turn, refresh only when the lists are older than this. */
const AFTER_TURN_MS = 60_000

const EMPTY: GitHubView = { status: 'idle', repo: '', prs: [], issues: [], error: '', updatedAt: 0, runId: 0 }
const view = atom({ plugin: 'github-panel', key: 'view' } as const, EMPTY)

// Dies with the module on a reload; session.start starts it again.
let every: Timer | undefined

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
    throw new Error(`could not run gh (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Loads the open PRs and issues of the session's repo. One load at a time;
 * a load superseded by a reload of the module is dropped by its runId.
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

  try {
    const repo = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    if (repo.exitCode !== 0) {
      const reason = lastLine(repo.stderr) || 'not a GitHub repository'
      await finish(current => ({ ...current, status: 'unavailable', error: reason, prs: [], issues: [] }))
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

/** Loads the lists, then opens the tab unless this is no GitHub repo. */
async function startUp($: EngineInterface, config: Config): Promise<void> {
  await load($, config)
  if ((await read($, view)).status !== 'unavailable') await $.ui.open({ id: PANE, title: TITLE })
}

/** Opens a PR, an issue, or a whole list in the browser through gh. */
async function openOnGitHub($: EngineInterface, args: readonly string[]): Promise<void> {
  const run = await gh($, [...args, '--web'])
  if (run.exitCode !== 0) $.ui.toast(`GitHub: ${lastLine(run.stderr) || 'could not open the browser'}`)
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'github', description: 'Open the GitHub tab of the side panel: open PRs and issues' })
    // A reload killed any load in flight: drop its loading state and its result.
    await update($, view, (current): GitHubView => ({
      ...current,
      status: current.status === 'loading' ? 'idle' : current.status,
      runId: current.runId + 1,
    }))
    every?.cancel()
    every = config.refreshMs > 0 ? $.clock.every(config.refreshMs, () => void load($, config).catch(report($))) : undefined
    void startUp($, config).catch(report($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const current = await read($, view)
    if (current.status !== 'unavailable' && (await $.clock.now()) - current.updatedAt > AFTER_TURN_MS) {
      void load($, config).catch(report($))
    }
    return done
  })

  on('command.run', { command: 'github' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void load($, config).catch(report($))
    return { text: 'GitHub tab opened.' }
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
          <Button key="all-prs" plain dimColor label="all" onPress={() => void openOnGitHub($, ['pr', 'list']).catch(report($))} />
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
          <Button key="all-issues" plain dimColor label="all" onPress={() => void openOnGitHub($, ['issue', 'list']).catch(report($))} />
        </Box>
        {current.issues.length === 0 && current.updatedAt > 0 && <Text dimColor>No open issues.</Text>}
        {current.issues.map(issue => (
          <Box key={`issue-row-${issue.number}`} flexDirection="column">
            <Button
              key={`issue-${issue.number}`}
              plain
              label={fit(`#${issue.number} ${issue.title}`, room)}
              onPress={() => void openOnGitHub($, ['issue', 'view', String(issue.number)]).catch(report($))}
            />
            {issueDetail(issue) !== '' && <Text dimColor wrap="truncate-end">  {issueDetail(issue)}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
