/**
 * A `git commit` or `git push` a shell command would run: the folders its `-C` options name, and for a push
 * the branches its refspecs push to, as written (`HEAD` for the current branch).
 */
export type GitCall =
  | { action: 'commit'; dirs: readonly string[] }
  | { action: 'push'; dirs: readonly string[]; destinations: readonly string[] }

const SEPARATORS = new Set(['&&', '||', '&', '|', ';', '\n', '(', ')'])
const GIT = /(?:^|[\\/])git(?:\.exe)?$/i
const ASSIGNMENT = /^[A-Za-z_]\w*=/
/** Options of git itself, before the command, that take the next word as their value. */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])
/** Options of `git push` that take the next word as their value. */
const PUSH_VALUED = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const REMOTE_DEFAULT = 'refs/remotes/origin/'

/** The command's words, with its quotes taken off, and each mark that ends a command as a word of its own. */
function words(command: string): string[] {
  const found: string[] = []
  let word = ''
  let isWord = false
  let quote: string | undefined
  const end = (): void => {
    if (isWord) found.push(word)
    word = ''
    isWord = false
  }
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at] ?? ''
    const next = command[at + 1] ?? ''
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else if (quote === '"' && char === '\\' && (next === '"' || next === '\\')) {
        word += next
        at += 1
      } else {
        word += char
      }
    } else if (char === "'" || char === '"') {
      quote = char
      isWord = true
    } else if (char === ' ' || char === '\t' || char === '\r') {
      end()
    } else if (SEPARATORS.has(char)) {
      end()
      const mark = SEPARATORS.has(char + next) ? char + next : char
      found.push(mark)
      at += mark.length - 1
    } else {
      word += char
      isWord = true
    }
  }
  end()
  return found
}

/** The branch a refspec pushes to, without its `+` and `refs/heads/`. */
function destination(refspec: string): string {
  const spec = refspec.replace(/^\+/, '')
  const target = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec
  return target.replace(/^refs\/heads\//, '')
}

/** The branches a push's words after `push` name as destinations: none when it names no refspec. */
function destinations(args: readonly string[]): string[] {
  const positional: string[] = []
  let isOptions = true
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? ''
    if (isOptions && arg === '--') isOptions = false
    else if (isOptions && arg.startsWith('-')) at += PUSH_VALUED.has(arg) ? 1 : 0
    else positional.push(arg)
  }
  // The first is the remote.
  return positional.slice(1).map(destination)
}

/** The commit or push one simple command runs, if it is one. */
function gitCall(command: readonly string[]): GitCall | undefined {
  let at = 0
  while (ASSIGNMENT.test(command[at] ?? '')) at += 1
  if (!GIT.test(command[at] ?? '')) return undefined
  const dirs: string[] = []
  for (at += 1; command[at]?.startsWith('-') === true; at += 1) {
    const option = command[at] ?? ''
    if (!GIT_VALUED.has(option)) continue
    at += 1
    if (option === '-C') dirs.push(command[at] ?? '')
  }
  const action = command[at]
  if (action === 'commit') return { action, dirs }
  if (action === 'push') return { action, dirs, destinations: destinations(command.slice(at + 1)) }
  return undefined
}

/** Every `git commit` and `git push` a shell command runs, in order. */
export function gitCallsIn(shell: string): GitCall[] {
  const calls: GitCall[] = []
  let command: string[] = []
  for (const word of [...words(shell), ';']) {
    if (!SEPARATORS.has(word)) {
      command.push(word)
      continue
    }
    const call = gitCall(command)
    if (call !== undefined) calls.push(call)
    command = []
  }
  return calls
}

/**
 * The default branch from `git for-each-ref --format=%(refname) %(symref)` over the remote's HEAD, `main` and
 * `master`: the branch the remote's HEAD points at, else `main`, else `master` when only that one exists.
 */
export function defaultBranch(refs: string): string {
  const lines = refs.split('\n').map(line => line.trim().split(' '))
  const remote = lines.find(([name]) => name === `${REMOTE_DEFAULT}HEAD`)?.[1] ?? ''
  if (remote.startsWith(REMOTE_DEFAULT)) return remote.slice(REMOTE_DEFAULT.length)
  const names = new Set(lines.map(([name]) => name))
  return names.has('refs/heads/master') && !names.has('refs/heads/main') ? 'master' : 'main'
}

/** The refs `defaultBranch` reads. */
export const DEFAULT_BRANCH_REFS = [`${REMOTE_DEFAULT}HEAD`, 'refs/heads/main', 'refs/heads/master']

/** The branches the call would change when run on `current`. */
export function branchesChanged(call: GitCall, current: string): string[] {
  if (call.action === 'commit' || call.destinations.length === 0) return [current]
  return call.destinations.map(branch => (branch === 'HEAD' ? current : branch))
}
