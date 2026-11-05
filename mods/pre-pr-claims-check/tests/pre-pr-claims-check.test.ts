import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findingsInDiff, findingsInText } from '../hooks/claims'
import { prCalls } from '../hooks/command'

/**
 * A whole-file diff of one Markdown file, as the mod asks git for it.
 * Each line starts with ' ' (kept), '+' (added) or '-' (removed).
 */
function markdownDiff(path: string, lines: readonly string[]): string {
  const old = lines.filter(line => !line.startsWith('+')).length
  const added = lines.filter(line => !line.startsWith('-')).length
  return [`diff --git ${path} ${path}`, 'index 1111111..2222222 100644', `--- ${path}`, `+++ ${path}`, `@@ -1,${old} +1,${added} @@`, ...lines, ''].join('\n')
}

/** The repo beneath the mod: what git and gh answer, the files it can read, and every call made. */
type Repo = { name: string; base: string; diff: string; isDiffFailing: boolean; vendorMarkers: string[]; isListFailing: boolean; sessionDir: string; files: Record<string, string>; runs: string[]; dirs: (string | undefined)[]; ran: string[] }

function repoOn(on: On, change: Partial<Repo> = {}): Repo {
  const repo: Repo = { name: 'acme/widget', base: 'main', diff: '', isDiffFailing: false, vendorMarkers: [], isListFailing: false, sessionDir: '/work/session', files: {}, runs: [], dirs: [], ran: [], ...change }
  const answer = (exitCode: number, stdout: string, stderr = '') =>
    ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    repo.runs.push(argv)
    repo.dirs.push(e.init?.cwd)
    if (argv.startsWith('gh repo view') && argv.includes('nameWithOwner')) return answer(0, `${repo.name}\n`)
    if (argv.startsWith('gh repo view')) return answer(0, `${repo.base}\n`)
    if (argv.startsWith('git ls-files')) return repo.isListFailing ? answer(128, '', 'fatal: not a git repository') : answer(0, repo.vendorMarkers.map(marker => `${marker}\0`).join(''))
    if (argv.startsWith('git diff')) return repo.isDiffFailing ? answer(128, '', "fatal: bad revision 'origin/main...HEAD'") : answer(0, repo.diff)
    return answer(1, '', 'unexpected command')
  })
  on('session.cwd', () => ({ value: repo.sessionDir }))
  // The engine hands the hook the path made absolute under the session's folder.
  on('fs.read', (_$, e) => {
    const name = Object.keys(repo.files).find(file => e.path.replaceAll('\\', '/').endsWith(`/${file}`))
    const text = name === undefined ? undefined : repo.files[name]
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${e.path}'`)
    return { value: text }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    repo.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
    repo.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return repo
}

function bashCreate(body: string): string {
  return `gh pr create --title "Add the guard" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`
}

test('prCalls reads the title, the body and the base, however the command passes them', () => {
  expect(prCalls(bashCreate('## Summary\n\nIt\'s "quoted".'), 'bash')).toEqual([
    { title: 'Add the guard', body: { text: '## Summary\n\nIt\'s "quoted".' } },
  ])
  expect(prCalls(`gh pr create -t 'One' -b "Two \\"three\\"" -B release && echo done`, 'bash')).toEqual([
    { title: 'One', body: { text: 'Two "three"' }, base: 'release' },
  ])
  expect(prCalls('gh pr create --title=One --body-file - <<EOF\nThe body\nEOF', 'bash')).toEqual([
    { title: 'One', body: { text: 'The body' } },
  ])
  expect(prCalls('cd repo && gh pr edit 12 --body-file notes.md', 'bash')).toEqual([{ dir: 'repo', body: { file: 'notes.md' } }])
  expect(prCalls("gh pr create --title \"It`\"s\" --body @'\nLine one\nLine two\n'@", 'powershell')).toEqual([
    { title: 'It"s', body: { text: 'Line one\nLine two' } },
  ])
})

test('prCalls finds no call in another gh command, nor in quoted text that names one', () => {
  expect(prCalls('gh pr view 12 --json title', 'bash')).toEqual([])
  expect(prCalls('gh issue create --title "x" --body "paths.ts:42"', 'bash')).toEqual([])
  expect(prCalls('git commit -m "run gh pr create later"', 'bash')).toEqual([])
  expect(prCalls("cat > notes.md <<'EOF'\ngh pr create --body x\nEOF", 'bash')).toEqual([])
})

test('findingsInText finds citations, placeholders and counts in words from eleven up', () => {
  const found = (text: string) => findingsInText(text, 'PR body').map(finding => `${finding.ban}: ${finding.text}`)
  expect(found('See paths.ts:42 and src/register.tsx:12-30.')).toEqual([
    'file:line citation: paths.ts:42',
    'file:line citation: src/register.tsx:12-30',
  ])
  expect(found('Closes (PR #NN), see #xx; TODO fill in')).toEqual([
    'placeholder: (PR #NN)',
    'placeholder: #xx',
    'placeholder: TODO fill in',
  ])
  expect(found('Adds forty-four entries, Twelve tests and two hundred files.')).toEqual([
    'count in words: forty-four entries',
    'count in words: Twelve tests',
    'count in words: two hundred files',
  ])
  expect(found('44 entries, two files, ten tests, eleven was enough, #12, https://example.com:8080/x')).toEqual([])
})

test('findingsInText passes over fenced code blocks', () => {
  expect(findingsInText('Before\n```ts\nconst at = "paths.ts:42"\n```\nAfter', 'PR body')).toEqual([])
  expect(findingsInText('~~~~\n```\npaths.ts:42\n~~~~\npaths.ts:9', 'PR body')).toEqual([
    { where: 'PR body', ban: 'file:line citation', text: 'paths.ts:9' },
  ])
})

test('findingsInDiff checks only the added lines, placed by file and line, with fences read from the whole file', () => {
  const diff =
    markdownDiff('docs/notes.md', [' Kept: paths.ts:1', '+Added (PR #NN)', '-Removed TODO fill in', ' ```', '+inside.ts:3', ' ```', '+++ fake header TODO fill in']) +
    markdownDiff('README.md', ['+Gone']).replace('+++ README.md', '+++ /dev/null')
  expect(findingsInDiff(diff)).toEqual([
    { where: 'docs/notes.md, line 2', ban: 'placeholder', text: '(PR #NN)' },
    { where: 'docs/notes.md, line 6', ban: 'placeholder', text: 'TODO fill in' },
  ])
})

test('a body holding a file:line citation is refused with the finding named; the same body without it goes through', async ($, on) => {
  const repo = repoOn(on)
  const refused = await $.tool.call({ tool: 'Bash', command: bashCreate('Fixes the check in paths.ts:42.') })
  expect(refused.deny).toContain('PR body: file:line citation "paths.ts:42"')
  expect(repo.ran).toEqual([])

  const command = bashCreate('Fixes the check in paths.ts.')
  const ran = await $.tool.call({ tool: 'Bash', command })
  expect(ran.deny).toBeUndefined()
  expect(repo.ran).toEqual([command])
})

test('an added Markdown line holding a placeholder refuses, naming the file', async ($, on) => {
  const repo = repoOn(on, { diff: markdownDiff('docs/guide.md', [' # Guide', '+Shipped in (PR #NN).', '+TODO fill in the steps']) })
  const refused = await $.tool.call({ tool: 'Bash', command: bashCreate('Adds the guide.') })
  expect(refused.deny).toContain('docs/guide.md, line 2: placeholder "(PR #NN)"')
  expect(refused.deny).toContain('docs/guide.md, line 3: placeholder "TODO fill in"')
  expect(repo.runs).toContain(`git diff --no-color --no-ext-diff --no-prefix --find-renames --unified=1000000 origin/main...HEAD -- :(icase)*.md :(icase)*.markdown`)
})

test('a count in words refuses; one in digits, one under eleven, or a citation in a fence does not', async ($, on) => {
  const repo = repoOn(on)
  const refused = await $.tool.call({ tool: 'Bash', command: bashCreate('Adds forty-four entries.') })
  expect(refused.deny).toContain('PR body: count in words "forty-four entries"')

  const command = bashCreate('Adds 44 entries to two files.\n\n```text\npaths.ts:42\n```')
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect(repo.ran).toEqual([command])
})

test('a title is checked as the body is', async ($, on) => {
  repoOn(on)
  const refused = await $.tool.call({ tool: 'Bash', command: 'gh pr create --title "Fix #XX" --body "Done."' })
  expect(refused.deny).toContain('PR title: placeholder "#XX"')
})

test('gh pr edit --body-file reads the file and checks it the same way', async ($, on) => {
  const repo = repoOn(on, { files: { 'notes.md': 'Moves twelve tests.\n' } })
  const refused = await $.tool.call({ tool: 'PowerShell', command: 'gh pr edit --body-file notes.md' })
  expect(refused.deny).toContain('PR body: count in words "twelve tests"')

  repo.files['notes.md'] = 'Moves the tests.\n'
  expect((await $.tool.call({ tool: 'PowerShell', command: 'gh pr edit --body-file notes.md' })).deny).toBeUndefined()
})

test('lines the branch did not add are not checked', async ($, on) => {
  const repo = repoOn(on, { diff: markdownDiff('README.md', [' See paths.ts:42 (PR #NN).', '+A new line.', ' Twenty files.']) })
  const command = bashCreate('Adds a line.')
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect(repo.ran).toEqual([command])
})

test('a folder with a .vendor.json is not checked; a sibling, and a folder whose name only starts the same, still are', async ($, on) => {
  const vendored = markdownDiff('skills/logo/principles.md', ['+The twelve principles.'])
  const repo = repoOn(on, { vendorMarkers: ['skills/logo/.vendor.json'], diff: vendored })
  const command = bashCreate('Adds a skill.')
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect(repo.ran).toEqual([command])
  repo.diff = vendored + markdownDiff('skills/logo-two/notes.md', ['+The twelve principles.'])
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('skills/logo-two/notes.md, line 1')
})

test('a .vendor.json at the repo root exempts nothing', async ($, on) => {
  repoOn(on, { vendorMarkers: ['.vendor.json'], diff: markdownDiff('README.md', ['+Twelve principles.']) })
  expect((await $.tool.call({ tool: 'Bash', command: bashCreate('Adds a line.') })).deny).toContain('README.md, line 1')
})

test('when git cannot list the markers, every file is still checked', async ($, on) => {
  repoOn(on, { isListFailing: true, diff: markdownDiff('skills/logo/principles.md', ['+The twelve principles.']) })
  expect((await $.tool.call({ tool: 'Bash', command: bashCreate('Adds a skill.') })).deny).toContain('skills/logo/principles.md, line 1')
})

test('the body is checked however the branch is vendored', async ($, on) => {
  repoOn(on, { vendorMarkers: ['skills/logo/.vendor.json'] })
  expect((await $.tool.call({ tool: 'Bash', command: bashCreate('See paths.ts:42.') })).deny).toContain('PR body')
})

test('prCalls reads the folder a cd leaves the command in, and the repo -R names', () => {
  expect(prCalls('cd /work/other && gh pr create -t One -b Two', 'bash')).toEqual([{ title: 'One', body: { text: 'Two' }, dir: '/work/other' }])
  expect(prCalls('cd /work && cd other && gh pr edit -b Two', 'bash')).toEqual([{ body: { text: 'Two' }, dir: '/work/other' }])
  expect(prCalls("Set-Location -Path 'C:\\work\\other'; gh pr edit -b Two", 'powershell')).toEqual([{ body: { text: 'Two' }, dir: 'C:\\work\\other' }])
  expect(prCalls('gh pr create -b Two -R acme/widget', 'bash')).toEqual([{ body: { text: 'Two' }, repo: 'acme/widget' }])
  expect(prCalls('cd "$(git rev-parse --show-toplevel)" && gh pr edit -b Two', 'bash')).toEqual([{ body: { text: 'Two' }, isDirUnknown: true }])
  expect(prCalls('gh pr edit -b One && cd /work/other', 'bash')).toEqual([{ body: { text: 'One' } }])
})

test('a cd before the call runs git and gh in that folder', async ($, on) => {
  const repo = repoOn(on, { diff: markdownDiff('README.md', ['+Twelve principles.']) })
  const { deny } = await $.tool.call({ tool: 'Bash', command: 'cd /work/other && gh pr create -t One -b Two' })
  expect(deny).toContain('README.md, line 1')
  expect(new Set(repo.dirs)).toEqual(new Set(['/work/other']))
})

test('without a cd, git and gh run in the session folder', async ($, on) => {
  const repo = repoOn(on)
  await $.tool.call({ tool: 'Bash', command: bashCreate('Adds a line.') })
  expect(new Set(repo.dirs)).toEqual(new Set([undefined]))
})

test('a Git Bash path becomes a drive path on Windows, and stays as it is elsewhere', async ($, on) => {
  const repo = repoOn(on, { sessionDir: 'E:\\work\\session' })
  await $.tool.call({ tool: 'Bash', command: 'cd /e/work/other && gh pr edit -b Two' })
  expect(new Set(repo.dirs)).toEqual(new Set(['E:/work/other']))
  repo.dirs.length = 0
  repo.sessionDir = '/work/session'
  await $.tool.call({ tool: 'Bash', command: 'cd /e/work/other && gh pr edit -b Two' })
  expect(new Set(repo.dirs)).toEqual(new Set(['/e/work/other']))
})

test('a folder the hook cannot resolve leaves the branch unchecked, and the body is still checked', async ($, on) => {
  const repo = repoOn(on, { diff: markdownDiff('README.md', ['+Twelve principles.']) })
  const unknown = 'cd "$HOME/other" && gh pr edit -b Two'
  expect((await $.tool.call({ tool: 'Bash', command: unknown })).deny).toBeUndefined()
  expect(repo.runs).toEqual([])
  const { deny } = await $.tool.call({ tool: 'Bash', command: 'cd "$HOME/other" && gh pr edit -b "See paths.ts:42."' })
  expect(deny).toContain('PR body')
})

test('-R naming another repo leaves the local branch unchecked, and the body is still checked', async ($, on) => {
  const repo = repoOn(on, { diff: markdownDiff('README.md', ['+Twelve principles.']) })
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr create -R acme/other -t One -b Two' })).deny).toBeUndefined()
  expect(repo.runs.some(run => run.startsWith('git diff'))).toBe(false)
  const { deny } = await $.tool.call({ tool: 'Bash', command: 'gh pr create -R acme/other -t One -b "See paths.ts:42."' })
  expect(deny).toContain('PR body')
})

test('-R naming the local repo checks the branch, whatever its form', async ($, on) => {
  repoOn(on, { diff: markdownDiff('README.md', ['+Twelve principles.']) })
  for (const named of ['acme/widget', 'ACME/Widget', 'github.com/acme/widget', 'https://github.com/acme/widget.git']) {
    expect((await $.tool.call({ tool: 'Bash', command: `gh pr create -R ${named} -t One -b Two` })).deny).toContain('README.md, line 1')
  }
})

test('a relative --body-file is read from the folder the cd left the command in', async ($, on) => {
  repoOn(on, { files: { 'other/notes.md': 'Moves twelve tests.\n' } })
  const { deny } = await $.tool.call({ tool: 'Bash', command: 'cd /work/other && gh pr edit --body-file notes.md' })
  expect(deny).toContain('PR body: count in words "twelve tests"')
})

test('--base sets what the branch is compared with, and gh is not asked for the default branch', async ($, on) => {
  const repo = repoOn(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base release --title "x" --body "y"' })
  expect(repo.runs.some(run => run.includes('origin/release...HEAD'))).toBe(true)
  expect(repo.runs.some(run => run.startsWith('gh '))).toBe(false)
})

test('other commands, gh ones included, are untouched and run nothing', async ($, on) => {
  const repo = repoOn(on, { diff: markdownDiff('README.md', ['+TODO fill in']) })
  const commands = ['gh pr view 12', 'gh issue create --title "x" --body "paths.ts:42"', 'git status']
  for (const command of commands) expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect(repo.ran).toEqual(commands)
  expect(repo.runs).toEqual([])
})

test('a branch git cannot compare is left unchecked, and the body is still checked', async ($, on) => {
  const repo = repoOn(on, { isDiffFailing: true })
  const command = bashCreate('Clean.')
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: bashCreate('TODO fill in') })).deny).toContain('placeholder')
  expect(repo.ran).toEqual([command])
})

test('in a headless session it still checks and refuses', async ($, on) => {
  on('session.surfaces', () => ({ value: [] }))
  const repo = repoOn(on, { diff: markdownDiff('README.md', ['+See paths.ts:42']) })
  const refused = await $.tool.call({ tool: 'Bash', command: bashCreate('Clean.') })
  expect(refused.deny).toContain('README.md, line 1: file:line citation "paths.ts:42"')
  expect(repo.ran).toEqual([])
})
