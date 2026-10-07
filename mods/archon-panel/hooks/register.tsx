import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ArchonView, RunNode } from '../types'
import { ago, fit, glyph, isLive, NEEDS_ARCHON, parseConfig, parseNodes, parseRuns, runTime } from './parse'
import type { Config } from './parse'

const PANE = 'archon'
const TITLE = 'Archon'
/** After a turn, refresh only when the runs are older than this. */
const AFTER_TURN_MS = 10_000
/** The most live runs whose nodes are fetched on one load. */
const MOST_LIVE = 3

const EMPTY: ArchonView = { status: 'idle', runs: [], selected: '', nodes: {}, error: '', updatedAt: 0, runId: 0 }
const view = atom({ plugin: 'archon-panel', key: 'view' } as const, EMPTY)
const hasStartedUp = atom({ plugin: 'archon-panel', key: 'hasStartedUp' } as const, false)

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
      const seen = attaches
      if (!(await isShown($))) {
        if (every === own && attaches === seen) stopPolling()
      } else if ((await read($, view)).status !== 'unavailable') await load($, config)
    })().catch(report($))
  })
  every = own
}

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`Archon: ${error instanceof Error ? error.message : String(error)}`)
}

function lastLine(output: string): string {
  const lines = output.trim().split(/\r?\n/)
  return lines[lines.length - 1]?.slice(0, 200) ?? ''
}

/** Runs the Archon CLI; one that cannot start (not installed) rejects with a message that says so. */
async function archon($: EngineInterface, config: Config, args: readonly string[]) {
  try {
    return await $.process.run([config.archon, ...args])
  } catch (error) {
    throw new Error(`could not run ${config.archon} (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
}

/** The nodes of one run, or none when its transcript cannot be read: the runs list still shows. */
async function nodesOf($: EngineInterface, config: Config, id: string): Promise<RunNode[]> {
  try {
    const run = await archon($, config, ['workflow', 'logs', id])
    return run.exitCode === 0 ? parseNodes(run.stdout) : []
  } catch {
    return []
  }
}

/**
 * Loads the recent runs and the nodes of the live and the selected ones. One
 * load at a time; a load superseded by a reload of the module is dropped by
 * its runId. A CLI that cannot start leaves the view `unavailable`.
 */
async function load($: EngineInterface, config: Config): Promise<void> {
  let runId = 0
  await update($, view, (current): ArchonView => {
    if (current.status === 'loading') {
      runId = 0
      return current
    }
    runId = current.runId + 1
    return { ...current, status: 'loading', error: '', runId }
  })
  if (runId === 0) return

  const finish = (change: (current: ArchonView) => ArchonView) =>
    update($, view, current => (current.runId === runId ? change(current) : current))

  try {
    let listed
    try {
      listed = await archon($, config, ['workflow', 'runs', '--json', '--limit', String(config.limit)])
    } catch {
      await finish(current => ({ ...current, status: 'unavailable', error: NEEDS_ARCHON, runs: [], nodes: {}, updatedAt: 0 }))
      return
    }
    if (listed.exitCode !== 0) throw new Error(lastLine(listed.stderr) || `archon exited with ${listed.exitCode}`)
    const runs = parseRuns(listed.stdout)
    const selected = (await read($, view)).selected
    const wanted = [
      ...runs.filter(isLive).slice(0, MOST_LIVE).map(run => run.id),
      ...(runs.some(run => run.id === selected && !isLive(run)) ? [selected] : []),
    ]
    const fetched = await Promise.all(wanted.map(async id => [id, await nodesOf($, config, id)] as const))
    const updatedAt = await $.clock.now()
    await finish(current => ({
      ...current,
      status: 'idle',
      error: '',
      runs,
      nodes: Object.fromEntries(fetched),
      updatedAt,
    }))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await finish(current => ({ ...current, status: 'error', error: reason }))
  }
}

/** The start-up work: loads the runs, then opens the pane unasked when `isPaneWanted` and a run is going. */
async function startUp($: EngineInterface, config: Config, isPaneWanted: boolean): Promise<void> {
  await load($, config)
  const current = await read($, view)
  if (isPaneWanted && current.status === 'idle' && current.runs.some(isLive)) await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'archon', description: 'Open the Archon pane in the side panel: workflow runs and their progress' })
    // A reload killed any load in flight: drop its loading state and its result.
    await update($, view, (current): ArchonView => ({
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

  on('command.run', { command: 'archon' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void load($, config).catch(report($))
    return { text: 'Archon pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, view)
    const now = await $.clock.now()
    const width = Math.max(16, e.props.bodyColumns)
    const room = width - 1
    const reload = () => void load($, config).catch(report($))
    const toggle = (id: string) => {
      void (async () => {
        await update($, view, (v): ArchonView => ({ ...v, selected: v.selected === id ? '' : id }))
        await load($, config)
      })().catch(report($))
    }
    const liveCount = current.runs.filter(isLive).length

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">{liveCount > 0 ? `Archon · ${liveCount} running` : TITLE}</Text>
          <Button key="refresh" plain dimColor hotkey="r" label="refresh" onPress={reload} />
        </Box>
        {current.status === 'loading' && current.updatedAt === 0 && <Text dimColor>Loading{'…'}</Text>}
        {(current.status === 'error' || current.status === 'unavailable') && (
          <Text color="red" wrap="wrap">{current.error}</Text>
        )}
        {current.updatedAt > 0 && <Text dimColor>updated {ago(now - current.updatedAt)}</Text>}
        {current.runs.length === 0 && current.updatedAt > 0 && <Text dimColor>No workflow runs yet.</Text>}

        {current.runs.map(run => {
          const nodes = current.nodes[run.id] ?? []
          const isOpen = isLive(run) || run.id === current.selected
          const color = run.state === 'failed' ? 'red' : run.state === 'running' ? 'green' : undefined
          const head = fit(`${glyph(run.state)} ${run.workflow}  ${runTime(run, now)}`, room)
          return (
            <Box key={`run-row-${run.id}`} flexDirection="column" marginTop={1}>
              {color === undefined
                ? <Button key={`run-${run.id}`} plain label={head} onPress={() => toggle(run.id)} />
                : <Button key={`run-${run.id}`} plain label={head} hover={{ color }} onPress={() => toggle(run.id)} />}
              {run.message !== '' && <Text dimColor wrap="truncate-end">  {run.message}</Text>}
              {isOpen && nodes.map(node => (
                <Text key={`node-${run.id}-${node.id}`} wrap="truncate-end" {...(node.state === 'failed' ? { color: 'red' } : node.state === 'completed' ? { dimColor: true } : {})}>
                  {'  '}{glyph(node.state)} {node.id}
                </Text>
              ))}
              {isOpen && nodes.length === 0 && current.updatedAt > 0 && <Text dimColor>  no node events yet</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
