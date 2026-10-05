/** One file read or folder searched: its full path with forward slashes, and when it was last read. */
export type Source = { path: string; at: number }

export type SourcesView = {
  /** Newest first, each path once. */
  sources: Source[]
  /** True while reads are kept to the project folder and the allowed folders. */
  isLocked: boolean
  /** Folders outside the project folder that the person allowed for this session. */
  allowed: string[]
}

declare module 'claude-code' {
  interface PluginState {
    sources: { view: SourcesView }
  }
}
