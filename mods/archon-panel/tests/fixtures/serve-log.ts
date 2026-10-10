// A pino NDJSON serve.log as `archon serve >> serve.log 2>&1` leaves it
// (docs/research/archon-run-data.md § Archon's own logs): info, warn and error
// lines, and one plain line from the Slack client's stderr.

import { T0 } from './runs'

const pino = (level: number, module: string, msg: string, at: number) =>
  JSON.stringify({ level, time: at, pid: 4242, hostname: 'box', module, msg })

export const SERVE_LOG = [
  pino(30, 'server', 'listening on 3090', T0),
  pino(40, 'adapter', 'rate limited, backing off', T0 + 60_000),
  pino(50, 'orchestrator', 'workflow failed to start', T0 + 120_000),
  '[slack] socket closed, reconnecting',
].join('\n') + '\n'
