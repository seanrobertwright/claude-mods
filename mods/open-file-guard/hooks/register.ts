import type { EngineInterface, Register } from 'claude-code'

import { lockPaths, officeFile, officeFilesIn } from './office'
import type { OfficeFile } from './office'

const CLOSED = 'I closed it'
const ANYWAY = 'Go ahead anyway'
const MOST_ASKS = 3

async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

async function isOpen($: EngineInterface, file: OfficeFile): Promise<boolean> {
  for (const lock of lockPaths(file)) {
    // A network location is not looked at; the call goes on as it would without the mod.
    if (await $.fs.exists(lock).catch(() => false)) return true
  }
  return false
}

// Files the person said to use while open; asked once, not at every call of the turn.
const waved = new Set<string>()

/** Undefined to let the call through, or why it is refused. */
async function guard($: EngineInterface, files: readonly OfficeFile[]): Promise<string | undefined> {
  if (files.length === 0 || !(await isShown($))) return undefined
  for (const file of files) {
    const id = file.path.toLowerCase()
    if (waved.has(id)) continue
    for (let asks = 0; await isOpen($, file); asks += 1) {
      const stillOpen = `open-file-guard: "${file.name}" is open in ${file.app}, so a write to it would fail. Ask the person to close it, then run this again.`
      if (asks === MOST_ASKS) return stillOpen
      const question = `"${file.name}" is ${asks === 0 ? '' : 'still '}open in ${file.app}, and Claude is about to use it. Close it so a write to it can go through?`
      const answer = await $.ui.ask(question, { header: 'Open file', options: [CLOSED, ANYWAY] }).catch(() => undefined)
      // Dismissed, or answered in other words: the call does not go on.
      if (answer === ANYWAY) {
        waved.add(id)
        break
      }
      if (answer !== CLOSED) return stillOpen
    }
  }
  return undefined
}

export const register: Register = on => {
  on('turn.complete', (_$, e, next) => {
    if (e.agentId === undefined) waved.clear()
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const file = officeFile(e.file_path)
    const deny = await guard($, file === undefined ? [] : [file])
    return deny === undefined ? next(e) : { deny }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const file = officeFile(e.file_path)
    const deny = await guard($, file === undefined ? [] : [file])
    return deny === undefined ? next(e) : { deny }
  })

  // Matched by pattern: which shell tools a session has depends on the machine.
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    const deny = await guard($, officeFilesIn(command))
    return deny === undefined ? next(e) : { deny }
  })
}
