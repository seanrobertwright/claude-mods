// What Log shows for a run that needs you: the approval view and its answer
// area, or the resume and abandon view, each action through a confirming step.

import type { Elements, RenderElement } from 'claude-code'

import type { ArchonActions, Detail, GraphNode, Run } from '../types'
import { ABANDON_LINE, answerButtons, platformName, SERVER_DOWN_NOTE, strandConfirm, strandHead, strandResume } from './actions'
import { waitNode } from './runs'
import type { NeedsYou } from './runs'
import { shortId } from './runs-view'
import { duration } from './text'

/** The most of a node's output "what it asks about" shows: its last lines. */
const ASKS_LINES = 10

export type ActionProps = {
  ui: Elements[keyof Elements]
  surface: string
  /** The run that needs you, and the run holding the gate (itself, or its sub-run). */
  run: Run
  need: NeedsYou
  parent: Run | undefined
  detail: Detail | undefined
  graph: GraphNode[] | null | undefined
  actions: ArchonActions
  now: number
  width: number
  isServer: boolean
  /** The run's page in Archon's web UI, or '' when it is not linked. */
  link: string
  /** Whether Log is cut to the gate's node; `a` widens what it asks about to the whole run log. */
  isCut: boolean
  /** The whole run log, drawn when `a` widened it. */
  log: RenderElement[]
  files: RenderElement[]
  onDecide: (decision: string, label: string) => void
  onResume: () => void
  onAbandon: () => void
  onConfirm: () => void
  onBack: () => void
  onText: (text: string) => void
  onAll: () => void
}

/** The area under a run that needs you: notices, then the buttons, the confirming step, or what is being sent. */
function answerArea(props: ActionProps): RenderElement[] {
  const { ui, run, need, actions } = props
  const { Box, Text, Button } = ui
  // The phone draws no Input.
  const Input = 'Input' in ui ? ui.Input : undefined
  const holder = need.holder
  const text = actions.text[holder.id] ?? ''
  const lines: RenderElement[] = []
  const pending = actions.pending?.runId === holder.id ? actions.pending : null
  if (actions.sending === holder.id) return lines
  const found = need.standing

  if (pending !== null) {
    let line: string
    if (pending.kind === 'answer') {
      line = `${pending.label.replace(/^[a-z]: /, '').replace(/ \(.*\)$/, '')} ${holder.workflow} ${shortId(holder.id)}${text === '' ? '' : ` · "${text}"`}`
      if (holder.hasConversation && !props.isServer) line = `${line} ${SERVER_DOWN_NOTE}`
    } else if (pending.kind === 'resume') {
      line = found.kind === 'stranded' ? strandConfirm(found.gate.nodeId, found.subRun) : `Resume: the run carries on from ${waitNode(found)}.`
    } else line = ABANDON_LINE
    const name = pending.kind === 'answer' ? 'Send' : `${pending.kind === 'resume' ? 'Resume' : 'Abandon'} ${holder.workflow}`
    lines.push(<Text wrap="wrap">{line}</Text>)
    lines.push(
      <Box key="confirming" flexDirection="row" columnGap={2}>
        <Button key="confirm" variant="primary" autoFocus label={name} onPress={props.onConfirm} />
        <Button key="back" hotkey="b" label="b: Back" onPress={props.onBack} />
      </Box>,
    )
    return lines
  }

  if (found.kind === 'approval') {
    const buttons = answerButtons(found.gate, holder, props.parent, text)
    lines.push(
      <Box key="answers" flexDirection="row" flexWrap="wrap" columnGap={2}>
        {buttons.map(button => (button.letter === ''
          ? <Button key={`decide-${button.decision}`} {...(button.isPrimary ? { variant: 'primary' as const } : {})} label={button.label} onPress={() => props.onDecide(button.decision, button.label)} />
          : <Button key={`decide-${button.decision}`} hotkey={button.letter} {...(button.isPrimary ? { variant: 'primary' as const } : {})} label={button.label} onPress={() => props.onDecide(button.decision, button.label)} />))}
      </Box>,
    )
    if (Input !== undefined && props.surface !== 'mobile') {
      lines.push(<Input key="comment" label="Comment or reason (optional)" placeholder="Comment or reason (optional)" value={text} onInput={(value: string) => props.onText(value)} onSubmit={(value: string) => props.onText(value)} />)
    } else lines.push(<Text dimColor>A comment needs the terminal or the desktop app.</Text>)
    if (found.gate.type === 'container_writeback' && props.link !== '' && ui.Link !== undefined) {
      const { Link } = ui
      lines.push(<Link key="diff-link" href={props.link} label="↗ Archon, for the full diff" />)
    }
    return lines
  }

  if (found.kind === 'action' || found.kind === 'stranded') {
    const row: RenderElement[] = []
    if (run.platform !== '' || holder.platform !== '') row.push(<Text dimColor>{`resume it from ${platformName(holder.platform || run.platform)}`}</Text>)
    else if (!isPathThere(props.detail)) row.push(<Text dimColor>{`can't resume: ${holder.workingPath} is gone`}</Text>)
    else {
      const label = found.kind === 'stranded' ? strandResume(found.subRun) : "r  Resume: I've done it"
      row.push(<Button key="resume" hotkey="r" variant="primary" label={label} onPress={props.onResume} />)
    }
    row.push(<Button key="abandon" hotkey="x" label="x  Abandon run" onPress={props.onAbandon} />)
    lines.push(<Box key="resume-row" flexDirection="row" flexWrap="wrap" columnGap={2}>{row}</Box>)
  }
  return lines
}

/** The node outputs a gate asks about: each node it waits on, its last part, under an `a` that widens it to the whole run log. */
function asksAbout(props: ActionProps): RenderElement[] {
  const { Box, Text, Button } = props.ui
  const node = waitNode(props.need.standing)
  const deps = props.graph?.find(n => n.id === node)?.deps ?? []
  const events = props.detail?.events ?? []
  const lines: RenderElement[] = [
    <Box key="asks" flexDirection="row" columnGap={1}>
      <Text dimColor>{`cut to ${node} ·`}</Text>
      <Button key="asks-all" plain dimColor hotkey="a" label="whole run log" onPress={props.onAll} />
    </Box>,
  ]
  for (const dep of deps) {
    const output = [...events].reverse().find(e => e.step === dep && e.type === 'node_completed')?.output ?? ''
    if (output === '') continue
    lines.push(<Text bold>{dep}</Text>)
    for (const line of output.replace(/\n+$/, '').split('\n').slice(-ASKS_LINES)) lines.push(<Text dimColor wrap="wrap">{line}</Text>)
  }
  const found = props.need.standing
  if (found.kind === 'approval' && found.gate.type === 'interactive_loop') {
    lines.push(<Text dimColor wrap="wrap">{found.gate.isRoundDone ? 'A bare approve finishes the loop; with a comment it runs another round.' : 'An approve runs another round, with your comment if you give one.'}</Text>)
  }
  return lines
}

/** The approval view, or the resume and abandon view, top to bottom. */
const isPathThere = (detail: ActionProps['detail']): boolean => detail?.isWorkingPathThere !== false

/**
 * Whether the answer area offers Resume, which then holds the `r` key: the
 * pinned row's reload gives it up (an answer's letter never takes `r`, but
 * Resume is `r` by name).
 */
export function offersResume(props: Pick<ActionProps, 'run' | 'need' | 'detail' | 'actions'>): boolean {
  const { standing, holder } = props.need
  if (standing.kind !== 'action' && standing.kind !== 'stranded') return false
  if (props.actions.pending?.runId === holder.id) return false
  return props.run.platform === '' && holder.platform === '' && isPathThere(props.detail)
}

export function actionBody(props: ActionProps): RenderElement[] {
  const { ui, need, now } = props
  const { Box, Text, Markdown, Link } = ui
  const holder = need.holder
  const found = need.standing
  const lines: RenderElement[] = []
  const waited = duration(now - found.since)
  if (found.kind === 'approval' || found.kind === 'unreadable') {
    const name = `${props.parent === undefined ? '' : `${props.parent.workflow} › sub-run `}${holder.workflow}`
    lines.push(
      <Box key="loghead" flexDirection="row" columnGap={1}>
        <Text bold wrap="truncate-end">{`${name} · ${shortId(holder.id)} · waited ${waited}`}</Text>
        {props.link !== '' && <Link key="archon-link" href={props.link} label="↗ Archon" />}
      </Box>,
    )
    if (found.kind === 'approval' && found.gate.message !== '') lines.push(<Markdown key="gate-message" text={found.gate.message} />)
    if (found.kind === 'unreadable') lines.push(<Text color="warning" wrap="wrap">This gate is one Archon can't read; answer it in Archon.</Text>)
  } else if (found.kind === 'action') {
    lines.push(<Text bold color="warning">{`⏸ Action needed · waiting ${waited}`}</Text>)
    lines.push(<Text wrap="wrap">{found.wait.message}</Text>)
  } else {
    lines.push(<Text bold color="warning">{strandHead(found.subRun)}</Text>)
    lines.push(<Text>{`Node ${found.gate.nodeId} can't go on.`}</Text>)
  }
  lines.push(...(props.isCut ? asksAbout(props) : props.log))
  lines.push(...props.files)
  lines.push(...answerArea(props))
  return lines
}
