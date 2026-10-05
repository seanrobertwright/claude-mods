/** One file made or changed since the session began. */
export type OutputFile = {
  /** The file's full path, as the application that opens it takes it. */
  path: string
  name: string
  /** Its folder under the project folder, with forward slashes; '' for the project folder itself. */
  folder: string
  mtimeMs: number
  /** True for what a person reads (Word, Excel, PowerPoint, PDF, Markdown, HTML, text); false for scripts, images and data. */
  isDocument: boolean
}

export type OutputsView = {
  /** When the session began: files changed before it are not listed. 0 until the first start. */
  since: number
  files: OutputFile[]
  /** True when the scan stopped at its bound, so the list may be short. */
  isCut: boolean
  isOtherOpen: boolean
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    outputs: { view: OutputsView }
  }
}
