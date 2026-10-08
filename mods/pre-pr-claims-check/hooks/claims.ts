/** A banned claim: where it is (a file and line, "PR body" or "PR title"), which ban, and the text matched. */
export type Finding = { where: string; ban: string; text: string }

const UNIT = 'one|two|three|four|five|six|seven|eight|nine'
const TEEN = 'eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen'
const TENS = `(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:${UNIT}))?`
const UNDER_HUNDRED = `${TEEN}|ten|${TENS}|${UNIT}`
const LARGE = `(?:a|${UNDER_HUNDRED})[- ](?:hundred|thousand|million)(?:[- ](?:and[- ])?(?:${UNDER_HUNDRED}))?`
// Words ending in s that are not plural nouns, so a count before them is not one.
const NOT_PLURAL = new Set(['was', 'has', 'does', 'goes', 'its', 'yes', 'always', 'across', 'perhaps', 'whereas', 'besides'])
const IRREGULAR_PLURAL = new Set(['people', 'children', 'men', 'women'])

const BANS: readonly { ban: string; pattern: RegExp; isFinding?: (match: RegExpMatchArray) => boolean }[] = [
  {
    ban: 'file:line citation',
    // A URL's host and port is not one: nothing before the name may join it to a scheme.
    pattern: /(?<![\w.:/\\@-])(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w-]+(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]*:\d+(?:-\d+)?(?![\w/])/g,
  },
  {
    ban: 'placeholder',
    pattern: /\(PR #NN\)|(?<!\w)#(?:NN|XX)(?!\w)|\bTODO:?\s+fill\s+in\b/gi,
  },
  {
    ban: 'count in words',
    pattern: new RegExp(`\\b(?:${LARGE}|${TEEN}|${TENS})\\s+([A-Za-z]+)\\b`, 'gi'),
    isFinding: match => isPlural(match[1]!),
  },
]

function isPlural(word: string): boolean {
  const lower = word.toLowerCase()
  if (IRREGULAR_PLURAL.has(lower)) return true
  return lower.length >= 3 && lower.endsWith('s') && !/(?:ss|us|is)$/.test(lower) && !NOT_PLURAL.has(lower)
}

/** The bans one line breaks. */
function findingsInLine(line: string, where: string): Finding[] {
  return BANS.flatMap(({ ban, pattern, isFinding }) =>
    [...line.matchAll(pattern)].filter(match => isFinding?.(match) ?? true).map(match => ({ where, ban, text: match[0] })),
  )
}

/** A fence line opens a fenced code block, or closes the one `open` started. */
function fenceOf(line: string): string | undefined {
  return /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
}

function closes(line: string, open: string): boolean {
  const fence = fenceOf(line)
  return fence !== undefined && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence
}

/**
 * The findings on the lines `where` names, outside fenced code blocks.
 * Every line is read for the fences; `where` answers undefined for a line not to check.
 */
export function findingsIn(lines: readonly string[], where: (index: number) => string | undefined): Finding[] {
  const found: Finding[] = []
  let open: string | undefined
  lines.forEach((line, index) => {
    if (open !== undefined) {
      if (closes(line, open)) open = undefined
      return
    }
    open = fenceOf(line)
    const place = where(index)
    if (open === undefined && place !== undefined) found.push(...findingsInLine(line, place))
  })
  return found
}

/** The findings in a PR's title or body. */
export function findingsInText(text: string, where: string): Finding[] {
  return findingsIn(text.split(/\r?\n/), () => where)
}

/** One file as a whole-file diff shows it: its lines after the change, and which of them the change added. */
type ChangedFile = { path: string; lines: string[]; isAdded: boolean[] }

function pathOf(header: string): string {
  const path = header.slice(4).replace(/\t$/, '')
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

/**
 * Reads `git diff --no-prefix` output whose context covers each whole file.
 * A hunk is read by its line counts, so an added line that starts with `++` is not taken for a header.
 */
function changedFiles(diff: string): ChangedFile[] {
  const files: ChangedFile[] = []
  const lines = diff.split('\n')
  let file: ChangedFile | undefined
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? undefined : { path: pathOf(line), lines: [], isAdded: [] }
      if (file !== undefined) files.push(file)
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (hunk === null || file === undefined) continue
    let old = Number(hunk[1] ?? 1)
    let added = Number(hunk[2] ?? 1)
    while ((old > 0 || added > 0) && at + 1 < lines.length) {
      const body = lines[(at += 1)]!.replace(/\r$/, '')
      const mark = body[0]
      if (mark === '\\') continue
      if (mark !== '+') old -= 1
      if (mark === '-') continue
      added -= 1
      file.lines.push(body.slice(1))
      file.isAdded.push(mark === '+')
    }
  }
  return files
}

/** The findings on the lines a whole-file diff of Markdown files adds, each placed by file and line. */
export function findingsInDiff(diff: string): Finding[] {
  return changedFiles(diff).flatMap(file =>
    findingsIn(file.lines, index => (file.isAdded[index] ? `${file.path}, line ${index + 1}` : undefined)),
  )
}

/** Why a gh call is refused: each finding, where it is and what it matched. */
export function refusal(findings: readonly Finding[]): string {
  return [
    'pre-pr-claims-check: this pull request breaks the claims bans. Fix each of these, then run the command again:',
    ...findings.map(finding => `- ${finding.where}: ${finding.ban} "${finding.text}"`),
    'Name a file without its line number, fill in or drop each placeholder, and leave out counts typed by hand.',
  ].join('\n')
}
