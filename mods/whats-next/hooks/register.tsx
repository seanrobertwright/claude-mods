import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextList, NextStep } from '../types'
import { buildAsk, DENIED_TOOLS, parseCached, parseConfig, parseSteps } from './parse'
import type { Config } from './parse'

const PANE = 'whats-next'
const POPUP = 'whats-next-prompt'
const TITLE = "What's next"
const TEN_MINUTES = 600_000

const EMPTY: NextList = { status: 'idle', steps: [], updatedAt: 0, error: '', runId: 0 }
const list = atom({ plugin: 'whats-next', key: 'list' } as const, EMPTY)
const selected = atom({ plugin: 'whats-next', key: 'selected' } as const, null)

const storeKey = (cwd: string) => `list:${cwd}`

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  return lines[lines.length - 1]?.slice(0, 200) ?? ''
}

/** The catch for work started and not awaited: say what failed instead of dropping it. */
const report = ($: EngineInterface) => (error: unknown) => {
  $.ui.toast(`What's next: ${error instanceof Error ? error.message : String(error)}`)
}

async function isGitRepo($: EngineInterface): Promise<boolean> {
  try {
    const { exitCode } = await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'])
    return exitCode === 0
  } catch {
    return false
  }
}

/**
 * Runs the skill in a headless `claude -p` beside this session, so the
 * conversation here is untouched, and replaces the list with its steps.
 * One run at a time; a run superseded by a reset is dropped by its runId.
 */
async function refresh($: EngineInterface, config: Config): Promise<void> {
  let runId = 0
  await update($, list, (current): NextList => {
    if (current.status === 'loading') {
      runId = 0
      return current
    }
    runId = current.runId + 1
    return { ...current, status: 'loading', error: '', runId }
  })
  if (runId === 0) return

  const finish = (change: (current: NextList) => NextList) =>
    update($, list, current => (current.runId === runId ? change(current) : current))

  try {
    // dontAsk denies every tool the rules do not allow. Only the person's own
    // settings load: a repo's .claude/settings.json could otherwise widen them.
    // The prompt arrives on stdin, so each variadic rule list ends at the next flag.
    const argv = [
      'claude', '-p',
      '--setting-sources', 'user',
      '--permission-mode', 'dontAsk',
      ...(config.model === '' ? [] : ['--model', config.model]),
      '--allowedTools', ...config.allowedTools,
      '--disallowedTools', ...DENIED_TOOLS,
    ]
    const run = await $.process.run(argv, {
      stdin: buildAsk(config.skill, config.maxSteps),
      timeoutMs: TEN_MINUTES,
      env: { WHATS_NEXT_CHILD: '1' },
    })
    if (run.exitCode !== 0) {
      const reason = lastLine(run.stderr) || lastLine(run.stdout) || `exit code ${run.exitCode}`
      await finish(current => ({ ...current, status: 'error', error: `claude -p failed: ${reason}` }))
      return
    }
    const steps = parseSteps(run.stdout, config.maxSteps)
    if (steps.length === 0) {
      await finish(current => ({ ...current, status: 'error', error: `${config.skill} answered with no prompt to list.` }))
      return
    }
    const updatedAt = await $.clock.now()
    await finish(current => ({ ...current, status: 'idle', steps, updatedAt, error: '' }))
    await $.store.set(storeKey(await $.session.cwd()), { steps, updatedAt })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await finish(current => ({ ...current, status: 'error', error: reason }))
  }
}

async function openPopup($: EngineInterface, step: NextStep): Promise<void> {
  await update($, selected, () => step)
  await $.ui.open({ id: POPUP, title: step.title, focus: true, closeOnEscape: true, holdToasts: true })
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    // The headless run this mod starts loads the person's plugins too: never recurse.
    if ((await $.env.get('WHATS_NEXT_CHILD')) === '1') return next(e)

    await $.command.register({
      name: 'whats-next',
      description: "Open the What's next sidebar; '/whats-next refresh' asks the skill again",
    })

    // A reload killed any run in flight: drop its loading state and its result.
    const cached = parseCached(await $.store.get(storeKey(await $.session.cwd())))
    await update($, list, (current): NextList => ({
      ...current,
      ...(cached ?? {}),
      status: current.status === 'loading' ? 'idle' : current.status,
      runId: current.runId + 1,
    }))

    void $.ui.open({ id: PANE, title: TITLE }).catch(report($))
    if (config.refreshOnStart && (await isGitRepo($))) void refresh($, config).catch(report($))

    return next(e)
  })

  on('command.run', { command: 'whats-next' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const current = await read($, list)
    const isAsked = e.args.trim() === 'refresh'
    if (isAsked || (current.steps.length === 0 && current.status !== 'loading')) void refresh($, config).catch(report($))

    return { text: isAsked ? `Asking ${config.skill} what's next.` : "What's next sidebar opened." }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, list)
    const now = await $.clock.now()
    const width = Math.max(16, e.props.bodyColumns)

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{TITLE}</Text>
          <Button
            key="refresh"
            plain
            dimColor
            hotkey="r"
            label="refresh"
            onPress={() => void refresh($, config).catch(report($))}
          />
        </Box>
        {current.status === 'loading' && (
          <Text dimColor wrap="wrap">Asking {config.skill}… this takes a minute or two.</Text>
        )}
        {current.status === 'error' && <Text color="red" wrap="wrap">{current.error}</Text>}
        {current.status !== 'loading' && current.updatedAt > 0 && (
          <Text dimColor>updated {ago(now - current.updatedAt)}</Text>
        )}
        {current.steps.length === 0 && current.status === 'idle' && (
          <Text dimColor wrap="wrap">No steps yet. Press r to ask {config.skill}.</Text>
        )}
        {current.steps.map((step, index) => (
          <Box key={`step-${index + 1}`} flexDirection="column" marginTop={1}>
            <Button
              key={`open-${index + 1}`}
              plain
              hotkey={String(index + 1)}
              variant={index === 0 ? 'primary' : 'secondary'}
              label={step.title}
              onPress={() => void openPopup($, step).catch(report($))}
            />
            {step.why !== '' && <Text dimColor wrap="wrap">{step.why}</Text>}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: POPUP }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const step = await read($, selected)
    const width = Math.max(16, e.props.bodyColumns)
    if (step === null) return <Text dimColor>No step selected.</Text>

    const close = () => $.ui.close({ id: POPUP })
    const paste = async () => {
      await close()
      await $.prompt.fill({ text: step.prompt })
    }
    const clearAndPaste = async () => {
      await close()
      await $.command.run({ command: 'clear' })
      await $.prompt.fill({ text: step.prompt })
    }
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: step.prompt, surface })
      await close()
      $.ui.toast(copied.isCopied ? 'Prompt copied.' : `Could not copy: ${copied.reason}`)
    }

    return (
      <Box flexDirection="column" width={width}>
        <Text bold wrap="wrap">{step.title}</Text>
        {step.why !== '' && <Text dimColor wrap="wrap">{step.why}</Text>}
        <Box borderStyle="round" borderDimColor paddingX={1} marginY={1} flexDirection="column">
          <Text wrap="wrap">{step.prompt}</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button
            key="paste"
            variant="primary"
            hotkey="p"
            autoFocus
            label="Paste into prompt"
            onPress={() => void paste().catch(report($))}
          />
          <Button
            key="fresh"
            hotkey="n"
            label="/clear + paste"
            onPress={() => void clearAndPaste().catch(report($))}
          />
          <Button
            key="copy"
            hotkey="c"
            label="Copy"
            onPress={press => void copy(press.surface).catch(report($))}
          />
          <Button key="close" role="dismiss" label="Close" onPress={() => void close().catch(report($))} />
        </Box>
        <Text dimColor wrap="wrap">Written for a fresh session: /clear + paste starts one. Esc closes.</Text>
      </Box>
    )
  })
}
