/** One preset: the model and the effort it switches the session to, under the name on its button. */
export type Preset = { name: string; model: string; effort: string }

/** The session's model, as `$.session.model()` reads it, and its effort; null until known. */
export type Current = { model: string; effort: string | null }

declare module 'claude-code' {
  interface PluginState {
    'model-effort-presets': { current: Current }
  }
}
