/** One check that did not pass: its name, why (an exit code, a timeout, a start that failed) and the end of its output. */
export type Failure = { name: string; why: string; tail: string }

/** Where the gate stands: what its band button shows. */
export type GateState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'passed' }
  | { kind: 'failed'; failures: Failure[] }
  /** There was nothing to run; `why` says what the mod looked for, or why the setting was refused. */
  | { kind: 'empty'; why: string }

declare module 'claude-code' {
  interface PluginState {
    'lint-test-gate': { gate: GateState }
  }
}
