// The mod's settings, parsed once at the boundary.

export type Toasts = 'all' | 'needs you' | 'off'

export type Config = {
  /** The Archon CLI the person named; '' finds it on the PATH or in `~/.archon/bin`. */
  archonPath: string
  /** Where `archon serve` answers. */
  port: number
  /** Archon's log file, `~` not yet expanded. */
  archonLog: string
  toasts: Toasts
  isStatusLine: boolean
}

export const DEFAULT_PORT = 3090
export const DEFAULT_LOG = '~/.archon/logs/serve.log'

const TOASTS: readonly Toasts[] = ['all', 'needs you', 'off']

/** Reads the settings: a blank path means find it, a port outside 1-65535 or not whole reads 3090, an unknown `toasts` reads `all`. */
export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const path = typeof options.archonPath === 'string' ? options.archonPath.trim() : ''
  const port = options.archonPort
  const log = typeof options.archonLog === 'string' && options.archonLog.trim() !== '' ? options.archonLog.trim() : DEFAULT_LOG
  const toasts = TOASTS.find(value => value === options.toasts) ?? 'all'
  return {
    archonPath: path,
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
    archonLog: log,
    toasts,
    isStatusLine: options.statusLine !== false,
  }
}
