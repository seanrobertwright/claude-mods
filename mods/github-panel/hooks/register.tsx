import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GitHubView, Pin, PullRequest } from '../types'
import {
  ago,
  blockerLines,
  branchPr,
  fillsWidth,
  fit,
  fixPrompt,
  frontier,
  ISSUE_FIELDS,
  issueDetail,
  logTail,
  missingRequirement,
  NEEDS_GH,
  parseConfig,
  parseIssues,
  parsePin,
  parsePrs,
  PIN_QUERY,
  pinArgument,
  PR_FIELDS,
  prDetail,
  watchChecks,
} from './parse'
import type { Config, Fill } from './parse'

const PANE = 'github'
const TITLE = 'GitHub'
/** The settings dialog's command and its gear's key (ADR-0007). mod-settings takes the press; the gear's onPress is the fallback. */
const SETTINGS = 'mod-settings'
/** After a turn, refresh only when the lists are older than this. */
const AFTER_TURN_MS = 60_000
/** The fewest columns an issue's detail line keeps beside the fill buttons; narrower, the buttons take a line of their own. */
const MIN_DETAIL = 12
/** The pinned issue's unpin button. */
const UNPIN = 'unpin'

const EMPTY: GitHubView = { status: 'idle', repo: '', branch: '', prs: [], issues: [], pin: null, error: '', updatedAt: 0, runId: 0 }
const view = atom({ plugin: 'github-panel', key: 'view' } as const, EMPTY)
const hasStartedUp = atom({ plugin: 'github-panel', key: 'hasStartedUp' } as const, false)
const watched = atom({ plugin: 'github-panel', key: 'watched' } as const, null)

// Dies with the module on a reload; session.start or the next attach starts it again.
let every: Timer | undefined
// Counts attaches, so a surfaces check answered before an attach cannot stop
// the polling that attach kept going.
let attaches = 0
// Set when a pin is made, so a load already running when it was made loads once more.
let isLoadAgain = false

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

/** The branch the session's folder is on; '' on a detached HEAD or where git cannot say. */
async function currentBranch($: EngineInterface): Promise<string> {
  const run = await $.process.run(['git', 'branch', '--show-current']).catch(() => undefined)
  return run?.exitCode === 0 ? run.stdout.trim() : ''
}

/** Toasts when the current branch's PR's checks turn passing or failing since the last load. */
async function noticeChecks($: EngineInterface, branch: string, prs: readonly PullRequest[]): Promise<void> {
  let toast: string | undefined
  await update($, watched, before => {
    const seen = watchChecks(before, branch, prs)
    toast = seen.toast
    return seen.watch
  })
  if (toast !== undefined) $.ui.toast(toast)
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
  // This load reads the store afresh: a pin made before now needs no other.
  isLoadAgain = false

  const finish = (change: (current: GitHubView) => GitHubView) =>
    update($, view, current => (current.runId === runId ? change(current) : current))

  const unavailable = (reason: string) =>
    finish(current => ({ ...current, status: 'unavailable', error: reason, repo: '', branch: '', prs: [], issues: [], pin: null, updatedAt: 0 }))

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
    const name = repo.stdout.trim()
    const pinned = wayfinderOf(config) === undefined ? undefined : await storedPin($, name)
    const [prs, issues, branch, pin] = await Promise.all([
      gh($, ['pr', 'list', '--state', 'open', '--limit', limit, '--json', PR_FIELDS]),
      gh($, ['issue', 'list', '--state', 'open', '--limit', limit, '--json', ISSUE_FIELDS]),
      currentBranch($),
      pinned === undefined ? null : readPin($, name, pinned),
    ])
    const failed = [prs, issues].find(run => run.exitCode !== 0)
    if (failed !== undefined) throw new Error(lastLine(failed.stderr) || `gh exited with ${failed.exitCode}`)
    const updatedAt = await $.clock.now()
    const next = { repo: name, branch, prs: parsePrs(prs.stdout), issues: parseIssues(issues.stdout), pin, updatedAt }
    let isCurrent = false
    await finish(current => {
      isCurrent = true
      return { ...current, ...next, status: 'idle', error: '' }
    })
    if (isCurrent) await noticeChecks($, branch, next.prs)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await finish(current => ({ ...current, status: 'error', error: reason }))
  } finally {
    if (isLoadAgain) void load($, config).catch(report($))
  }
}

/** The wayfinder fill: its command names the skill pinning watches and fills `work next`; none when the setting is empty. */
function wayfinderOf(config: Config): Fill | undefined {
  return config.fills.find(fill => fill.key === 'wayfinder')
}

/** The store key of a repo's pin: one pin per repo, kept across sessions. */
function pinKey(repo: string): string {
  return `pin:${repo}`
}

/** The issue pinned in `repo`, from the store; undefined with none. A store that cannot be read holds none, and the lists still load. */
async function storedPin($: EngineInterface, repo: string): Promise<number | undefined> {
  const value = await $.store.get(pinKey(repo)).catch(() => undefined)
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Drops `repo`'s pin of `number`; a pin made since, of another issue, stays. */
async function dropPin($: EngineInterface, repo: string, number: number): Promise<void> {
  if ((await storedPin($, repo)) === number) await $.store.delete(pinKey(repo))
}

/**
 * Reads the pinned issue and its sub-issues in one `gh api graphql` call. A
 * closed issue, or one that no longer resolves, drops the pin: null. A pin
 * dropped or replaced while the read ran is null too. Any other failure throws.
 */
async function readPin($: EngineInterface, repo: string, number: number): Promise<Pin | null> {
  const [owner = '', name = ''] = repo.split('/')
  const run = await gh($, ['api', 'graphql', '-f', `query=${PIN_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`])
  let pin: Pin | null | undefined
  try {
    pin = parsePin(run.stdout)
  } catch (error) {
    if (run.exitCode === 0) throw error
  }
  if (pin === undefined || (run.exitCode !== 0 && pin !== null)) {
    throw new Error(lastLine(run.stderr) || `gh exited with ${run.exitCode}`)
  }
  if (pin === null || !pin.isOpen) {
    await dropPin($, repo, number)
    return null
  }
  return (await storedPin($, repo)) === number ? pin : null
}

/**
 * Pins the issue a run of the watched skill works on, when the first word of
 * its arguments is an issue of the pane's repo; anything else does nothing and
 * says nothing. The person typed the command, so a shown session opens the
 * pane with focus and loads the pin at once.
 */
async function pinFromSkill($: EngineInterface, config: Config, skillText: string): Promise<void> {
  let repo = (await read($, view)).repo
  if (repo === '') {
    const run = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).catch(() => undefined)
    repo = run?.exitCode === 0 ? run.stdout.trim() : ''
  }
  const number = pinArgument(skillText, repo)
  if (number === undefined) return
  await $.store.set(pinKey(repo), number)
  // Another issue's read no longer stands; the load below draws the new one.
  await update($, view, current => (current.pin === null || current.pin.number === number ? current : { ...current, pin: null }))
  if (!(await isShown($))) return
  await $.ui.open({ id: PANE, title: TITLE, focus: true })
  isLoadAgain = true
  await load($, config)
}

/** Unpins the pinned issue: gone from the store and the pane. */
async function unpin($: EngineInterface): Promise<void> {
  const { repo, pin } = await read($, view)
  if (pin === null) return
  await dropPin($, repo, pin.number)
  await update($, view, current => (current.pin?.number === pin.number ? { ...current, pin: null } : current))
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

/** The failed run's log, cut to its last lines; none when the checks name no Actions run or gh cannot fetch it. */
async function failedLog($: EngineInterface, pr: PullRequest): Promise<string[]> {
  const runId = pr.failed.find(check => check.runId !== '')?.runId
  if (runId === undefined) return []
  // A run still going, or whose logs expired, answers with an error: the request goes without its log.
  const run = await gh($, ['run', 'view', runId, '--log-failed']).catch(() => undefined)
  return run?.exitCode === 0 ? logTail(run.stdout) : []
}

/** Fills a request to fix `pr`'s failing checks into the prompt box; nothing is sent. */
async function fillFix($: EngineInterface, pr: PullRequest): Promise<void> {
  await fillPrompt($, fixPrompt(pr, await failedLog($, pr)), 'fix request')
}

/**
 * Puts `text` in the prompt box; nothing is sent. The person types there next,
 * so the prompt box needs the keyboard, and closing the pane is the one way a
 * mod hands it back: the pane is closed, then opened again without asking for
 * the keyboard, as whats-next does. `what` names the text in the toast when
 * the prompt box refuses it.
 */
async function fillPrompt($: EngineInterface, text: string, what = 'command'): Promise<void> {
  await $.ui.close({ id: PANE })
  try {
    const filled = await $.prompt.fill({ text })
    if (!filled.isFilled) $.ui.toast(`GitHub: the prompt box could not take the ${what}.`)
  } finally {
    await $.ui.open({ id: PANE, title: TITLE })
  }
}

/** Whether mod-settings is installed: the gear shows only then. A command list that cannot be read shows none. */
async function isSettingsInstalled($: EngineInterface): Promise<boolean> {
  return (await $.command.list().catch(() => [])).some(command => command.name === SETTINGS)
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)
  const wayfinder = wayfinderOf(config)

  on('session.start', async ($, e, next) => {
    for (const problem of config.problems) $.ui.toast(problem)
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

  // The skill the wayfinder setting names, without its `/`; an empty setting turns pinning off.
  if (wayfinder !== undefined) {
    on('skill.prompt', { skill: wayfinder.command.slice(1) }, async ($, e, next) => {
      const done = await next(e)
      void pinFromSkill($, config, e.text).catch(report($))
      return done
    })
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const hasSettings = await isSettingsInstalled($)
    const current = await read($, view)
    const now = await $.clock.now()
    const width = Math.max(16, e.props.bodyColumns)
    const room = width - 1
    const isFull = (count: number) => count >= config.limit
    const mine = branchPr(current.prs, current.branch)
    // The fill buttons sit at the right of an issue's detail line, or on a line of their own when that leaves it too little.
    const isFillBeside = 2 + MIN_DETAIL + 1 + fillsWidth(config.fills) <= width
    const pin = wayfinder === undefined ? null : current.pin
    const map = pin === null ? undefined : frontier(pin.subIssues)

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">{current.repo === '' ? TITLE : current.repo}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Button key="refresh" plain dimColor hotkey="r" label="refresh" onPress={() => void load($, config).catch(report($))} />
            {hasSettings && <Button key={SETTINGS} plain dimColor label="⚙️" onPress={() => void $.command.run({ command: SETTINGS }).catch(report($))} />}
          </Box>
        </Box>
        {current.status === 'loading' && <Text dimColor>Loading{'…'}</Text>}
        {(current.status === 'error' || current.status === 'unavailable') && (
          <Text color="red" wrap="wrap">{current.error}</Text>
        )}
        {current.status !== 'loading' && current.updatedAt > 0 && <Text dimColor>updated {ago(now - current.updatedAt)}</Text>}

        {pin !== null && map !== undefined && wayfinder !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Button
                key="pin-issue"
                plain
                label={fit(pin.title, room - UNPIN.length - 1)}
                onPress={() => void openOnGitHub($, ['issue', 'view', String(pin.number)]).catch(report($))}
              />
              <Button key="unpin" plain dimColor label={UNPIN} onPress={() => void unpin($).catch(report($))} />
            </Box>
            <Text dimColor wrap="truncate-end">
              {pin.subIssues.length === 0
                ? 'no tickets yet'
                : `${map.done} done · ${map.takeable} takeable · ${map.claimed} claimed · ${map.blocked} blocked`}
            </Text>
            {pin.subIssues.length > 0 && (map.next === undefined
              ? <Text dimColor>nothing takeable</Text>
              : (
                <Box flexDirection="row" columnGap={1}>
                  <Button
                    key="pin-next"
                    plain
                    label={fit(`next: ${map.next.title}`, map.next.type === '' ? room : Math.max(8, room - map.next.type.length - 1))}
                    onPress={() => void openOnGitHub($, ['issue', 'view', String(map.next?.number)]).catch(report($))}
                  />
                  {map.next.type !== '' && <Text dimColor wrap="truncate-end">{map.next.type}</Text>}
                </Box>
              ))}
            {(pin.subIssues.length === 0 || map.next !== undefined) && pin.url !== '' && (
              <Button
                key="work-next"
                plain
                dimColor
                label="work next"
                onPress={() => void fillPrompt($, `${wayfinder.command} ${pin.url}`).catch(report($))}
              />
            )}
          </Box>
        )}

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
            {prDetail(pr) !== '' && (
              <Box flexDirection="row" justifyContent="space-between">
                <Text dimColor wrap="truncate-end">  {prDetail(pr)}</Text>
                {pr.number === mine?.number && pr.checks === 'failing' && (
                  <Button key={`fix-${pr.number}`} plain label="fix" onPress={() => void fillFix($, pr).catch(report($))} />
                )}
              </Box>
            )}
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
          const detail = issueDetail(issue)
          // A Button's label takes no color at rest, so a blocked issue's detail line is the red one.
          const detailText = detail !== '' && (isBlocked
            ? <Text color="red" wrap="truncate-end">  {detail}</Text>
            : <Text dimColor wrap="truncate-end">  {detail}</Text>)
          const fills = issue.url === '' ? [] : config.fills.map(fill => (
            <Button
              key={`${fill.key}-${issue.number}`}
              plain
              dimColor
              label={fit(fill.label, width - 2)}
              onPress={() => void fillPrompt($, `${fill.command} ${issue.url}`).catch(report($))}
            />
          ))
          return (
            <Box key={`issue-row-${issue.number}`} flexDirection="column">
              {isBlocked
                ? <Button key={`issue-${issue.number}`} plain label={label} hover={{ color: 'red' }} onPress={open} />
                : <Button key={`issue-${issue.number}`} plain label={label} onPress={open} />}
              {fills.length === 0
                ? detailText
                : isFillBeside
                  ? (
                    <Box flexDirection="row" columnGap={1}>
                      <Box flexGrow={1} flexShrink={1}>{detailText}</Box>
                      <Box flexDirection="row" columnGap={1} flexShrink={0}>{fills}</Box>
                    </Box>
                  )
                  : (
                    <Box flexDirection="column">
                      {detailText}
                      <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={2}>{fills}</Box>
                    </Box>
                  )}
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
