export type Config = { thresholdMs: number }

const MINUTE = 60_000
const DEFAULT_MINUTES = 3

/** The mod's sound, a path inside the mod's own folder. */
export const SOUND = 'sounds/chime.wav'

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const minutes = options.thresholdMinutes
  const isUsable = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
  return { thresholdMs: (isUsable ? minutes : DEFAULT_MINUTES) * MINUTE }
}

/** A length of time as the toast says it: `45s`, `4m 12s`, `1h 6m`. */
export function length(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The process that plays the sound on Windows, where the engine's own player
 * plays nothing: PowerShell's SoundPlayer on the file under the mod's folder.
 */
export function windowsPlayer(root: string): string[] {
  const file = `${root.replace(/[\\/]+$/, '')}\\${SOUND.replace(/\//g, '\\')}`
  const quoted = `'${file.replace(/'/g, "''")}'`
  return ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer ${quoted}).PlaySync()`]
}
