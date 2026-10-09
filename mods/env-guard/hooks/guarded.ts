/** The extra file-name patterns the setting gives, compiled, and the ones passed over as malformed. */
export type Patterns = { guarded: RegExp[]; rejected: string[] }

/**
 * A file-name glob as a case-insensitive match on the whole name: `*` is any characters and `?` one.
 * As in a shell, a leading wildcard does not match a leading dot, so `*.key` passes over jq's `.key`.
 */
function compiled(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${/^[*?]/.test(glob) ? '(?!\\.)' : ''}${body}$`, 'i')
}

const BUILT_IN = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*'].map(compiled)
/** Built-in names that hold no secret: the templates of a `.env`, and the public half of a key pair. */
const NOT_SECRET = ['.env.example', '.env.sample', '.env.template', 'id_rsa*.pub', 'id_ed25519*.pub'].map(compiled)

/**
 * The setting's patterns, separated by commas. A pattern with a folder in it, or with `[ ]` or `{ }`, which
 * the mod does not read as a glob, is passed over and given back, so the person can be told.
 */
export function parsePatterns(value: unknown): Patterns {
  const each = typeof value === 'string' ? value.split(',').map(pattern => pattern.trim()).filter(pattern => pattern !== '') : []
  const isMalformed = (pattern: string) => /[\\/[\]{}]|\p{Cc}/u.test(pattern)
  return { guarded: each.filter(pattern => !isMalformed(pattern)).map(compiled), rejected: each.filter(isMalformed) }
}

/** What the person is told once when the setting has patterns the mod passed over. */
export function rejectedNotice(rejected: readonly string[]): string {
  const quoted = rejected.map(pattern => `"${pattern}"`).join(', ')
  return `env-guard: More guarded files has ${quoted}, which ${rejected.length === 1 ? 'is not a file name' : 'are not file names'} and so guard nothing. A pattern is a name, with * and ? as wildcards and no folder, [ ] or { }.`
}

/** Whether a file name is guarded: on the built-in list and not a template or a public key, or matching a pattern of the setting. */
export function isGuarded(name: string, extra: readonly RegExp[]): boolean {
  if (extra.some(pattern => pattern.test(name))) return true
  return BUILT_IN.some(pattern => pattern.test(name)) && !NOT_SECRET.some(pattern => pattern.test(name))
}

/**
 * The path with forward slashes, its `.` and `..` segments folded and no trailing slash, so two spellings
 * of a place compare equal. A `..` at a drive, share or root stays there, as the file system has it;
 * one at the start of a relative path is kept. Copied from sources (ADR-0001).
 */
export function normal(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const [, head = '', rest = ''] = /^(\/\/[^/]+\/[^/]+|[A-Za-z]:(?=\/|$)|\/?)(.*)$/.exec(slashed) ?? []
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
    else if (head === '') parts.push(part)
  }
  const body = parts.join('/')
  if (head === '') return body === '' ? '.' : body
  // A bare drive or the root keeps its slash; a share has none of its own.
  if (head.startsWith('//')) return body === '' ? head : `${head}/${body}`
  return head === '/' ? `/${body}` : `${head}/${body}`
}

/**
 * The guarded file a path or a glob names, by the last part of it once folded, or undefined when it names
 * none. A glob's last part counts both as written (`*.pem`) and with its wildcards dropped (`.env*`).
 */
export function guardedName(spelling: string, extra: readonly RegExp[]): string | undefined {
  const folded = normal(spelling)
  const name = folded.slice(folded.lastIndexOf('/') + 1)
  return [name, name.replace(/[*?]/g, '')].some(each => isGuarded(each, extra)) ? name : undefined
}

/**
 * What a read tool's call names: the file Read reads or the path Grep and Glob search, and the file-name
 * filter Glob's `pattern` or Grep's `glob` gives. Grep's own `pattern` is a regex, not a path.
 */
export function namedBy(tool: string, input: object): { path?: string; filter?: string } {
  const { file_path: file, path, pattern, glob } = input as { file_path?: unknown; path?: unknown; pattern?: unknown; glob?: unknown }
  const named = typeof file === 'string' ? file : typeof path === 'string' ? path : undefined
  const filter = tool === 'Glob' ? pattern : tool === 'Grep' ? glob : undefined
  return { ...(named === undefined ? {} : { path: named }), ...(typeof filter === 'string' ? { filter } : {}) }
}

/**
 * The guarded files a shell command names, each once. A quoted path counts whole, spaces and all, and every
 * word counts on its own, so `bash -c "cat .env"` and `--env-file=.env` are seen too. A file the command
 * reaches without naming it is not.
 */
export function guardedIn(command: string, extra: readonly RegExp[]): string[] {
  const quoted = [...command.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)].map(match => match[1] ?? match[2] ?? '')
  const words = command.split(/[\s"'`|<>;()&,=]+/)
  const found = new Map<string, string>()
  for (const spelling of [...quoted, ...words]) {
    const name = spelling === '' ? undefined : guardedName(spelling, extra)
    if (name !== undefined && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), name)
  }
  return [...found.values()]
}

/** Names as a sentence lists them: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** What the person is asked before the call goes on. */
export function question(names: readonly string[]): string {
  return `Let Claude read ${listed(names)}?`
}

/** Why the call is refused, for the model to pass on: asked and not allowed, or no one there to ask. */
export function refusal(names: readonly string[], isAsked: boolean, hasKeypick: boolean): string {
  const files = listed(names)
  const holds = names.length === 1 ? 'holds' : 'hold'
  const why = isAsked
    ? `env-guard: the person did not let Claude read ${files}, which ${holds} secrets.`
    : `env-guard: ${files} ${holds} secrets, and in this session no one is there to let Claude read ${names.length === 1 ? 'it' : 'them'}.`
  const instead = ' To run something that needs a key, use the keypick skill instead: it hands the command its keys without showing them.'
  return hasKeypick ? `${why}${instead}` : why
}
