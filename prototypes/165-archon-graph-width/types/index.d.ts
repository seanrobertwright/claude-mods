export type WideMode = 'list' | 'stack'
export type SkipMode = 'lane' | 'note' | 'none'
export type LastScroll = { by: number; origin: string; pointerRow: number | null; at: string }

declare module 'claude-code' {
  interface PluginState {
    'archon-graph-proto': {
      fixture: number
      wide: WideMode
      skip: SkipMode
      pinned: boolean
      own: number
      asked: number
      lastScroll: LastScroll | null
    }
  }
}
