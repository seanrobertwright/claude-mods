/** One thing on the shelf: the short name on its button and the path it stands for. */
export type Entry = { name: string; path: string }

declare module 'claude-code' {
  interface PluginState {
    shelf: { entries: Entry[] }
  }
}
