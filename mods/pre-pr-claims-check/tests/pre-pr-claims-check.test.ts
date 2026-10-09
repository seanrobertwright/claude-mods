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
type Repo = { base: string; diff: string; isDiffFailing: boolean; files: Record<string, string>; runs: string[]; ran: string[] }

function repoOn(on: On, change: Partial<Repo> = {}): Repo {
  const repo: Repo = { base: 'main', diff: '', isDiffFailing: false, files: {}, runs: [], ran: [], ...change }
  const answer = (exitCode: number, stdout: string, stderr = '') =>
    ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    repo.runs.push(argv)
    if (argv.startsWith('gh repo view')) return answer(0, `${repo.base}\n`)
    if (argv.startsWith('git diff')) return repo.isDiffFailing ? answer(128, '', "fatal: bad revision 'origin/main...HEAD'") : answer(0, repo.diff)
    return answer(1, '', 'unexpected command')
  })
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
  expect(prCalls('cd repo && gh pr edit 12 --body-file notes.md', 'bash')).toEqual([{ body: { file: 'notes.md' } }])
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
