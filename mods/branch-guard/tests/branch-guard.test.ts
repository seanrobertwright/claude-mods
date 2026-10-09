import { expect, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { branchesChanged, defaultBranch, gitCallsIn } from '../hooks/git'

const ORIGIN_MAIN = 'refs/heads/main \nrefs/remotes/origin/HEAD refs/remotes/origin/main\n'

/**
 * The world beneath the mod: the checked-out branch (none when HEAD is detached), the refs git reports, what the
 * person answers, and the git runs and shell commands that got through.
 */
type World = {
  head: string | undefined
  refs: string
  isRepo: boolean
  answers: string[]
  asked: string[]
  git: (readonly string[])[]
  ran: string[]
}

function engineBeneath(on: On, surfaces: readonly RenderSurface[] = ['terminal']): World {
  const world: World = { head: 'main', refs: ORIGIN_MAIN, isRepo: true, answers: [], asked: [], git: [], ran: [] }
  on('session.surfaces', () => ({ value: surfaces }))
  on('process.run', (_$, e) => {
    world.git.push(e.argv)
    const isHead = e.argv.includes('symbolic-ref')
    const exitCode = !world.isRepo ? 128 : isHead && world.head === undefined ? 1 : 0
    const stdout = exitCode !== 0 ? '' : isHead ? `${world.head}\n` : world.refs
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    world.asked.push(question)
    const answer = world.answers.shift()
    // No answer left stands for the person dismissing the dialog.
    if (answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    world.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
    world.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return world
}

test('gitCallsIn finds each commit and push in a command, after git options and inside a chain', () => {
  expect(gitCallsIn('git add . && git commit -m "fix: one; two" && git push')).toEqual([
    { action: 'commit', dirs: [] },
    { action: 'push', dirs: [], destinations: [] },
  ])
  expect(gitCallsIn('git -C "../other repo" -c user.name=x commit -m x')).toEqual([{ action: 'commit', dirs: ['../other repo'] }])
  expect(gitCallsIn('GIT_EDITOR=true /usr/bin/git commit --amend')).toEqual([{ action: 'commit', dirs: [] }])
  expect(gitCallsIn('& git.exe commit -m x')).toEqual([{ action: 'commit', dirs: [] }])
})

test('gitCallsIn reads where a push goes from its refspecs, past its options', () => {
  expect(gitCallsIn('git push origin main')).toEqual([{ action: 'push', dirs: [], destinations: ['main'] }])
  expect(gitCallsIn('git push -u origin HEAD:main')).toEqual([{ action: 'push', dirs: [], destinations: ['main'] }])
  expect(gitCallsIn('git push --force-with-lease -o ci.skip origin +feat:refs/heads/main v1.0')).toEqual([
    { action: 'push', dirs: [], destinations: ['main', 'v1.0'] },
  ])
  expect(gitCallsIn('git push origin HEAD')).toEqual([{ action: 'push', dirs: [], destinations: ['HEAD'] }])
  expect(gitCallsIn('git push origin :main')).toEqual([{ action: 'push', dirs: [], destinations: ['main'] }])
  expect(gitCallsIn('git push origin \\\nmain')).toEqual([{ action: 'push', dirs: [], destinations: ['main'] }])
})

test('gitCallsIn takes no redirection for a refspec, nor a 2>&1 for the end of a command', () => {
  const push = [{ action: 'push', dirs: [], destinations: [] }]
  expect(gitCallsIn('git push origin 2>&1')).toEqual(push)
  expect(gitCallsIn('git push -u origin &> push.log')).toEqual(push)
  expect(gitCallsIn('git push origin > /dev/null 2>&1')).toEqual(push)
  expect(gitCallsIn('git push origin *>$null')).toEqual(push)
  expect(gitCallsIn('git push origin 2>&1 | tail -3')).toEqual(push)
  expect(gitCallsIn('git push origin main 2>&1')).toEqual([{ action: 'push', dirs: [], destinations: ['main'] }])
  expect(gitCallsIn('git commit -F - <<\'EOF\'\nfix: one\nEOF')).toEqual([{ action: 'commit', dirs: [] }])
  expect(gitCallsIn('git commit -m "$(cat <<\'EOF\'\nfix: one; git push\nEOF\n)"')).toEqual([{ action: 'commit', dirs: [] }])
})

test('gitCallsIn passes over other git commands and a commit that is only text', () => {
  expect(gitCallsIn('git status && git log --oneline -5')).toEqual([])
  expect(gitCallsIn('git -C ../repo diff')).toEqual([])
  expect(gitCallsIn('echo "git commit -m x"')).toEqual([])
  expect(gitCallsIn('echo git push')).toEqual([])
  expect(gitCallsIn('echo ";" git commit -m x')).toEqual([])
  expect(gitCallsIn('npm run commit')).toEqual([])
})

test('defaultBranch takes the remote HEAD, else main, else master', () => {
  expect(defaultBranch('refs/remotes/origin/HEAD refs/remotes/origin/trunk\n')).toBe('trunk')
  expect(defaultBranch(ORIGIN_MAIN)).toBe('main')
  expect(defaultBranch('refs/heads/main \nrefs/heads/master \n')).toBe('main')
  expect(defaultBranch('refs/heads/master \n')).toBe('master')
  expect(defaultBranch('')).toBe('main')
})

test('branchesChanged is the current branch, unless a push names where it goes', () => {
  expect(branchesChanged({ action: 'commit', dirs: [] }, 'feat')).toEqual(['feat'])
  expect(branchesChanged({ action: 'push', dirs: [], destinations: [] }, 'feat')).toEqual(['feat'])
  expect(branchesChanged({ action: 'push', dirs: [], destinations: ['HEAD', 'main'] }, 'feat')).toEqual(['feat', 'main'])
})

test('branchesChanged on a detached HEAD is only the branches a push names', () => {
  expect(branchesChanged({ action: 'commit', dirs: [] }, undefined)).toEqual([])
  expect(branchesChanged({ action: 'push', dirs: [], destinations: [] }, undefined)).toEqual([])
  expect(branchesChanged({ action: 'push', dirs: [], destinations: ['HEAD', 'main'] }, undefined)).toEqual(['main'])
})

test('on the default branch a commit is asked about, and "Go ahead" lets it run', async ($, on) => {
  const world = engineBeneath(on)
  world.answers.push('Go ahead on main')
  const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(world.asked).toEqual(['Claude is about to commit to main, the default branch. Create a branch first?'])
  expect(ran.deny).toBeUndefined()
  expect(world.ran).toEqual(['git commit -m x'])
})

test('on the default branch a dismissed push is refused with a reason that names the branch', async ($, on) => {
  const world = engineBeneath(on)
  const ran = await $.tool.call({ tool: 'PowerShell', command: 'git push' })
  expect(world.asked.length).toBe(1)
  expect(ran.deny).toContain('main is the default branch')
  expect(ran.deny).toContain('Create a branch first')
  expect(world.ran).toEqual([])
})

test('"Branch first" refuses the call', async ($, on) => {
  const world = engineBeneath(on)
  world.answers.push('Branch first')
  const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(ran.deny).toContain('Create a branch first')
  expect(world.ran).toEqual([])
})

test('a commit and a push in one command are asked about once', async ($, on) => {
  const world = engineBeneath(on)
  world.answers.push('Go ahead on main')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x && git push' })
  expect(world.asked.length).toBe(1)
  expect(world.ran.length).toBe(1)
})

test('the default branch the remote names is the one guarded', async ($, on) => {
  const world = engineBeneath(on)
  world.head = 'trunk'
  world.refs = 'refs/heads/main \nrefs/remotes/origin/HEAD refs/remotes/origin/trunk\n'
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(world.asked[0]).toContain('commit to trunk')
})

test('on a feature branch a commit and a push run unasked, and a push to the default branch is asked about', async ($, on) => {
  const world = engineBeneath(on)
  world.head = 'feat/x'
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/x' })
  expect(world.asked).toEqual([])
  expect(world.ran).toEqual(['git commit -m x', 'git push -u origin feat/x'])

  const ran = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(world.asked).toEqual(['Claude is about to push to main, the default branch. Create a branch first?'])
  expect(ran.deny).toContain('main is the default branch')
})

test('on the default branch a push with its output redirected is still asked about', async ($, on) => {
  const world = engineBeneath(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'git push origin 2>&1' })
  expect(world.asked.length).toBe(1)
  expect(ran.deny).toContain('main is the default branch')
})

test('git -C <dir> commit is caught and git is asked about that folder; git status and git log are not', async ($, on) => {
  const world = engineBeneath(on)
  await $.tool.call({ tool: 'Bash', command: 'git status && git log --oneline' })
  expect(world.git).toEqual([])
  expect(world.ran).toEqual(['git status && git log --oneline'])

  const ran = await $.tool.call({ tool: 'Bash', command: 'git -C ../repo commit -m x' })
  expect(world.git.every(argv => argv[0] === 'git' && argv[1] === '-C' && argv[2] === '../repo')).toBe(true)
  expect(world.asked.length).toBe(1)
  expect(ran.deny).toContain('main is the default branch')
})

test('when git cannot say the branch the call goes on untouched', async ($, on) => {
  const world = engineBeneath(on)
  world.isRepo = false
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  world.isRepo = true
  world.head = undefined
  await $.tool.call({ tool: 'Bash', command: 'git commit -m y' })
  expect(world.asked).toEqual([])
  expect(world.ran).toEqual(['git commit -m x', 'git commit -m y'])
})

test('on a detached HEAD a dismissed push to the default branch is refused with a reason that names the branch', async ($, on) => {
  const world = engineBeneath(on)
  world.head = undefined
  const ran = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD:main' })
  expect(world.asked).toEqual(['Claude is about to push to main, the default branch. Create a branch first?'])
  expect(ran.deny).toContain('main is the default branch')
  expect(world.ran).toEqual([])
})

test('on a detached HEAD a push naming the default branch is asked about, and "Go ahead" lets it run', async ($, on) => {
  const world = engineBeneath(on)
  world.head = undefined
  world.answers.push('Go ahead on main')
  const ran = await $.tool.call({ tool: 'PowerShell', command: 'git push origin main' })
  expect(world.asked).toEqual(['Claude is about to push to main, the default branch. Create a branch first?'])
  expect(ran.deny).toBeUndefined()
  expect(world.ran).toEqual(['git push origin main'])
})

test('on a detached HEAD a commit, a bare push and a push of HEAD run unasked', async ($, on) => {
  const world = engineBeneath(on)
  world.head = undefined
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  expect(world.asked).toEqual([])
  expect(world.ran).toEqual(['git commit -m x', 'git push', 'git push origin HEAD'])
})

test('in a folder git cannot read even a push naming the default branch goes on unasked', async ($, on) => {
  const world = engineBeneath(on)
  world.isRepo = false
  world.head = undefined
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD:main' })
  expect(world.asked).toEqual([])
  expect(world.ran).toEqual(['git push origin HEAD:main'])
})

test('in a headless session nothing is asked, git is not run, and every call goes on', async ($, on) => {
  const world = engineBeneath(on, [])
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  await $.tool.call({ tool: 'PowerShell', command: 'git push origin main' })
  expect(world.asked).toEqual([])
  expect(world.git).toEqual([])
  expect(world.ran).toEqual(['git commit -m x', 'git push origin main'])
})
