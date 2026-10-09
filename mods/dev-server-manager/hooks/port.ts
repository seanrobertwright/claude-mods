// The port check before a start: is anything listening on the port, and who.

/** A listener on the port: its process name ('' when unknown) and PID (0 when unknown). */
export type Holder = { name: string; pid: number }

/** What the check found: free, taken (with the row's words), or not checked because the tool is missing. */
export type PortCheck = { status: 'free' } | { status: 'taken'; words: string } | { status: 'unchecked' }

/** `$.process.run` as the check uses it; rejects when the command cannot start. */
export type Runner = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string }>

/** Where the port ends a `host:port` address, the port split at the last colon so `[::1]:5173` reads. */
function portOf(address: string): number {
  return Number(address.slice(address.lastIndexOf(':') + 1))
}

/**
 * The PIDs listening on `port` in `netstat -ano`: TCP rows whose local address
 * ends in the port and whose foreign address is `0.0.0.0:0` or `[::]:0`, the
 * mark of a listener whatever language the state word is in. PID 0 is none.
 */
export function parseNetstat(text: string, port: number): number[] {
  const pids: number[] = []
  for (const line of text.split(/\r?\n/)) {
    const [proto, local, foreign, ...rest] = line.trim().split(/\s+/)
    if (proto?.toUpperCase() !== 'TCP' || local === undefined || foreign === undefined) continue
    if (foreign !== '0.0.0.0:0' && foreign !== '[::]:0') continue
    if (portOf(local) !== port) continue
    const pid = Number(rest[rest.length - 1])
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid)
  }
  return pids
}

/** The listeners `ss -ltnpH` printed: every line is one, named by its `users:` field when it has one. */
export function parseSs(text: string): Holder[] {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => {
      const match = /users:\(\("([^"]+)",pid=(\d+)/.exec(line)
      return match === null ? { name: '', pid: 0 } : { name: match[1] ?? '', pid: Number(match[2]) }
    })
}

/** The listeners `lsof -nP -iTCP:<port> -sTCP:LISTEN` printed, under its header: COMMAND then PID. */
export function parseLsof(text: string): Holder[] {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && !line.startsWith('COMMAND'))
    .map(line => {
      const [name = '', pid = '0'] = line.trim().split(/\s+/)
      return { name, pid: Number(pid) || 0 }
    })
}

/** The image name of `tasklist /FO CSV /NH`'s one row; '' when the PID has gone. */
export function parseTasklist(text: string): string {
  const match = /^"([^"]+)","\d+"/m.exec(text)
  return match?.[1] ?? ''
}

/** The row's words for a taken port: `:6006 taken by node.exe 18244`, the holder left out when it has no name. */
export function holderWords(port: number, holder: Holder): string {
  const name = holder.pid === 4 && holder.name === '' ? 'System' : holder.name
  return name === '' ? `:${port} taken` : `:${port} taken by ${name}${holder.pid > 0 ? ` ${holder.pid}` : ''}`
}

/** The listeners on `port`, or undefined when no tool to list them could start. */
async function listeners(run: Runner, isWindows: boolean, port: number): Promise<Holder[] | undefined> {
  if (isWindows) {
    const netstat = await run(['netstat', '-ano']).catch(() => undefined)
    return netstat === undefined ? undefined : parseNetstat(netstat.stdout, port).map(pid => ({ name: '', pid }))
  }
  // ss on Linux; where it is missing (macOS), lsof.
  const ss = await run(['ss', '-ltnpH', `sport = :${port}`]).catch(() => undefined)
  if (ss !== undefined && ss.exitCode === 0) return parseSs(ss.stdout)
  const lsof = await run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).catch(() => undefined)
  return lsof === undefined ? undefined : parseLsof(lsof.stdout)
}

/**
 * Checks `port` before a start: any listener on any address takes it. The
 * holder is named only when taken (`tasklist` on Windows, the listing's own
 * name elsewhere), and only when `isNaming`, since a poll needs no name.
 */
export async function checkPort(run: Runner, isWindows: boolean, port: number, isNaming = true): Promise<PortCheck> {
  const found = await listeners(run, isWindows, port)
  if (found === undefined) return { status: 'unchecked' }
  const [first] = found
  if (first === undefined) return { status: 'free' }
  if (!isNaming) return { status: 'taken', words: `:${port} taken` }
  let holder = first
  if (isWindows && first.pid !== 4) {
    const tasklist = await run(['tasklist', '/FI', `PID eq ${first.pid}`, '/FO', 'CSV', '/NH']).catch(() => undefined)
    holder = { ...first, name: tasklist === undefined ? '' : parseTasklist(tasklist.stdout) }
  }
  return { status: 'taken', words: holderWords(port, holder) }
}
