import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Pending } from '../types'
import { formatWait, parseConfig, parseMinutes, planResume } from './plan'
import type { Config } from './plan'

const TICK = 30_000

const pending = atom({ plugin: 'auto-resume', key: 'pending' } as const, null)
const attempts = atom({ plugin: 'auto-resume', key: 'attempts' } as const, 0)
const now = atom({ plugin: 'auto-resume', key: 'now' } as const, 0)

// Timers die with the module on a reload; session.start re-arms from $.state.
let fire: Timer | undefined
let tick: Timer | undefined

function report($: EngineInterface): (error: unknown) => void {
  return error => $.ui.toast(`auto-resume: ${error instanceof Error ? error.message : String(error)}`)
}

function stopTimers(): void {
  fire?.cancel()
  tick?.cancel()
  fire = undefined
  tick = undefined
}

async function showStatus($: EngineInterface, config: Config): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  const waiting = await read($, pending)
  $.ui.status(waiting === null ? undefined : `⏳ "${config.text}" in ${formatWait(waiting.resumeAt - at)}`)
}

async function disarm($: EngineInterface): Promise<void> {
  stopTimers()
  await update($, pending, () => null)
  $.ui.status(undefined)
}

async function resume($: EngineInterface, config: Config): Promise<void> {
  if ((await read($, pending)) === null) return
  await disarm($)
  await update($, attempts, count => count + 1)
  await $.prompt.submit({ text: config.text, asUser: true })
}

async function arm($: EngineInterface, config: Config, plan: Pending): Promise<void> {
  stopTimers()
  await update($, pending, () => plan)
  const wait = Math.max(0, plan.resumeAt - (await $.clock.now()))
  fire = $.clock.after(wait, () => void resume($, config).catch(report($)))
  tick = $.clock.every(TICK, () => void showStatus($, config).catch(report($)))
  await showStatus($, config)
}

export const register: Register = (on, options) => {
  const config = parseConfig(options)
  // A `claude -p` run (an SDK origin) has nobody waiting on it: never resume there.
  let isHeadless = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-resume',
      description: "Rate-limit auto-resume: '/auto-resume' for status, 'now', 'cancel', or 'in <minutes>'",
    })
    const waiting = await read($, pending)
    if (waiting !== null) await arm($, config, waiting)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'sdk') isHeadless = true
    // The person typed something themselves: they have taken over.
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && (await read($, pending)) !== null) {
      await disarm($)
      $.ui.toast('Auto-resume cancelled: you took over.')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') await update($, attempts, () => 0)
    return done
  })

  on('classic.StopFailure', async ($, e, next) => {
    const done = await next(e)
    if (isHeadless) return done
    const at = await $.clock.now()
    const { rateLimits } = await $.session.usage()
    const plan = planResume({ error: e.error, rateLimits, now: at, attempts: await read($, attempts), config })
    if (plan === undefined) {
      if (e.error === 'rate_limit') $.ui.toast('Auto-resume gave up: too many retries in a row.')
      return done
    }
    await arm($, config, plan)
    $.ui.toast(`${plan.reason}: sending "${config.text}" in ${formatWait(plan.resumeAt - at)}.`)
    return done
  })

  on('command.run', { command: 'auto-resume' }, async ($, e) => {
    const [verb = '', amount = ''] = e.args.trim().split(/\s+/)
    if (verb === 'now') {
      if ((await read($, pending)) === null) return { text: 'Nothing is waiting to resume.' }
      void resume($, config).catch(report($))
      return { text: `Sending "${config.text}" now.` }
    }
    if (verb === 'cancel') {
      await disarm($)
      return { text: 'Auto-resume cancelled.' }
    }
    if (verb === 'in') {
      const minutes = parseMinutes(amount)
      if (minutes === undefined) return { text: 'Usage: /auto-resume in <minutes>, 1 to 1440.' }
      await arm($, config, { resumeAt: (await $.clock.now()) + minutes * 60_000, reason: 'scheduled by you' })
      return { text: `Will send "${config.text}" in ${formatWait(minutes * 60_000)}.` }
    }
    if (verb !== '') return { text: 'Usage: /auto-resume [now | cancel | in <minutes>]' }
    const waiting = await read($, pending)
    if (waiting === null) return { text: 'Auto-resume is idle; it arms itself when a turn hits a rate limit.' }
    return { text: `${waiting.reason}: sending "${config.text}" in ${formatWait(waiting.resumeAt - (await $.clock.now()))}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const waiting = await read($, pending)
    if (waiting === null || e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const at = await read($, now)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={e.props.bodyColumns}>
        <Text color="yellow">{'⏳'} {waiting.reason}:</Text>
        <Text>
          sending "{config.text}" in {formatWait(waiting.resumeAt - at)}
        </Text>
        <Button key="now" variant="primary" label="Resume now" onPress={() => void resume($, config).catch(report($))} />
        <Button key="cancel" label="Cancel" onPress={() => void disarm($).catch(report($))} />
      </Box>
    )
  })
}
