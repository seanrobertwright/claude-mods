// The Runs sub-tab: this project's runs, needs-you first, their sub-runs nested.

import type { Elements, RenderElement } from 'claude-code'

import type { ArchonData, ArchonView, Run } from '../types'
import { hasEnded, needsYou, sortRuns, standing, subRunsOf, topRuns } from './runs'
import type { Standing } from './runs'
import { isPinned } from './scope'
import type { Platform } from './scope'
import { clockTime, colour, duration, firstLine, fit, glyph } from './text'
import type { Look } from './text'

export type RunsProps = {
  ui: Elements[keyof Elements]
  data: ArchonData
  view: ArchonView
  now: number
  width: number
  platform: Platform
  serverLine: string
  /** Where a run's page in Archon's web UI starts, `http://localhost:<port>/console/r/`; '' when runs are not linked. */
  linkBase: string
  onPick: (run: Run) => void
  onFanout: (parentId: string) => void
}

/** A run's short id, as Log's header and the adoption lines name it. */
export function shortId(id: string): string {
  return id.slice(0, 7)
}

/** How a run looks: its glyph's state, from its status and what it waits on. */
export function lookOf(run: Run, found: Standing): Look {
  if (found.kind === 'approval' || found.kind === 'blocked' || found.kind === 'resuming') return 'approval'
  if (found.kind === 'action' || found.kind === 'stranded') return 'action'
  if (found.kind === 'unreadable') return 'unreadable'
  if (found.kind === 'waiting') return 'waiting'
  return run.status === 'paused' ? 'paused' : run.status
}

/** The status word beside a run's name. */
function wordOf(run: Run, found: Standing, isHeldBelow: boolean): string {
  switch (found.kind) {
    case 'approval': return 'needs your approval'
    case 'action': return 'action needed'
    case 'stranded': return 'stuck: sub-run ended'
    case 'unreadable': return "gate Archon can't read"
    case 'blocked': return isHeldBelow ? 'approval in sub-run' : 'waiting on a sub-run'
    case 'resuming': return 'resuming…'
    case 'waiting': return found.wait.until !== '' ? `waits until ${clockTime(Date.parse(found.wait.until))}` : `waits for ${found.wait.event || 'an event'}`
    default: return run.status
  }
}

/** Time running, or taken once ended. */
function timeOf(run: Run, now: number): string {
  return duration((hasEnded(run) ? run.completedAt : now) - run.startedAt)
}

/** How a sub-run ended, as a stranded parent shows it. */
function endingOf(subRun: Run | undefined): string {
  if (subRun === undefined) return 'ended'
  if (subRun.status === 'completed') return 'done'
  if (subRun.status === 'cancelled') return subRun.completedAt > 0 ? `cancelled ${clockTime(subRun.completedAt)}` : 'cancelled'
  return subRun.status
}

/** The adoption line: which run this one continues, or is continued by. */
function adoption(run: Run, runs: readonly Run[]): string[] {
  const named = (id: string) => {
    const other = runs.find(r => r.id === id)
    return other === undefined ? shortId(id) : `${other.workflow} ${shortId(id)}`
  }
  const lines: string[] = []
  if (run.adoptedFromId !== '') lines.push(`continues ${named(run.adoptedFromId)}`)
  for (const later of runs.filter(r => r.adoptedFromId === run.id)) lines.push(`continued by ${named(later.id)}`)
  return lines
}

export function runsBody(props: RunsProps): RenderElement[] {
  const { ui, data, view, now, width } = props
  const { Box, Text, Button, Link } = ui
  const room = Math.max(8, width - 2)
  const lines: RenderElement[] = []
  const project = data.project

  if (project !== null && project.ids.length === 0 && data.loadedAt > 0) lines.push(<Text dimColor>This folder isn't in an Archon project</Text>)
  if (data.others.live > 0) lines.push(<Text dimColor>+{data.others.live} live in other projects</Text>)
  if (data.source === 'cli') lines.push(<Text dimColor wrap="wrap">{props.serverLine}</Text>)
  if (project === null || project.ids.length === 0) return lines

  const row = (run: Run, depth: number, isHere: boolean) => {
    const found = standing(run, data.runs, data.details[run.id])
    const need = needsYou(run, data.runs, data.details)
    const look = lookOf(run, found)
    const indent = '  '.repeat(depth)
    const mark = depth > 0 ? '↳' : glyph(look)
    const label = `${run.workflow}  ${wordOf(run, found, need !== undefined && need.holder.id !== run.id)}  ${timeOf(run, now)}`
    const isPicked = view.run === run.id
    const isDim = run.status === 'cancelled' || found.kind === 'blocked' || found.kind === 'resuming' || found.kind === 'waiting'
    const tone = colour(look)
    lines.push(
      <Box key={`run-${run.id}`} flexDirection="row">
        <Text inverse={isPicked}>{isPicked ? '▸' : ' '}{indent}</Text>
        <Text {...(tone === undefined ? {} : { color: tone })} dimColor={isDim}>{mark}</Text>
        <Text> </Text>
        <Button key={`pick-${run.id}`} plain dimColor={isDim} label={fit(label, room - indent.length - 2 - (found.kind === 'unreadable' && props.linkBase !== '' ? 10 : 0))} onPress={() => props.onPick(run)} />
        {found.kind === 'unreadable' && props.linkBase !== '' && <Text> </Text>}
        {found.kind === 'unreadable' && props.linkBase !== '' && <Link key={`link-${run.id}`} href={`${props.linkBase}${run.id}`} label="↗ Archon" />}
      </Box>,
    )
    if (depth > 0) return
    const parts: string[] = []
    if (found.kind === 'action') parts.push(firstLine(found.wait.message))
    else if (found.kind === 'stranded') parts.push(`${found.subRun?.workflow ?? 'sub-run'} ${endingOf(found.subRun)}`)
    else if (run.message !== '') parts.push(run.message)
    parts.push(...adoption(run, data.runs))
    const detail = `${isHere ? 'here · ' : ''}${parts.filter(part => part !== '').join(' · ')}`
    if (detail !== '') {
      lines.push(need === undefined
        ? <Text dimColor wrap="truncate-end">{`  ${detail}`}</Text>
        : <Text color="warning" wrap="truncate-end">{`  ${detail}`}</Text>)
    }
  }

  const family = (run: Run, isHere: boolean) => {
    row(run, 0, isHere)
    const subRuns = subRunsOf(run, data.runs)
    if (subRuns.length === 0) return
    const isFolded = (subRuns.length > 1 || hasEnded(run)) && !view.fanouts.includes(run.id)
    if (isFolded) {
      const count = (test: (subRun: Run) => boolean) => subRuns.filter(test).length
      const parts = [
        `${subRuns.length} sub-run${subRuns.length === 1 ? '' : 's'}`,
        ...[
          [count(subRun => !hasEnded(subRun)), 'running'],
          [count(subRun => subRun.status === 'failed'), 'failed'],
          [count(subRun => subRun.status === 'cancelled'), 'cancelled'],
          [count(subRun => subRun.status === 'completed'), 'done'],
        ].filter(([n]) => n !== 0).map(([n, word]) => `${n} ${word}`),
      ]
      lines.push(
        <Box key={`run-fanout-${run.id}`} flexDirection="row">
          <Text>{'   '}↳ </Text>
          <Button key={`fanout-${run.id}`} plain label={fit(parts.join(' · '), room - 5)} onPress={() => props.onFanout(run.id)} />
        </Box>,
      )
      return
    }
    if (subRuns.length > 1) {
      lines.push(
        <Box key={`run-fanout-${run.id}`} flexDirection="row">
          <Text>{'   '}▾ </Text>
          <Button key={`fanout-${run.id}`} plain dimColor label={fit(`${subRuns.length} sub-runs`, room - 5)} onPress={() => props.onFanout(run.id)} />
        </Box>,
      )
    }
    for (const subRun of subRuns) row(subRun, 1, false)
  }

  const tops = topRuns(data.runs)
  if (tops.length === 0) {
    if (data.loadedAt > 0) lines.push(<Text dimColor>No workflow runs here yet.</Text>)
    return lines
  }
  const here = tops.filter(run => isPinned(run, project.primary, project.top, props.platform)).sort((a, b) => b.startedAt - a.startedAt)
  const rest = sortRuns(tops.filter(run => !here.includes(run)), data.runs, data.details)
  if (here.length > 0) {
    lines.push(<Text dimColor wrap="truncate-end">{project.branch === '' ? 'this worktree' : project.branch}</Text>)
    for (const run of here) family(run, true)
    lines.push(<Text dimColor>─ project ─</Text>)
  }
  for (const run of rest) family(run, false)
  return lines
}
