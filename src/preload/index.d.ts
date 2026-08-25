import type { LecternApi } from './index'

/**
 * Declaration merging: this is what lets the renderer call `window.lectern`
 * with full types, without the renderer importing anything from the preload
 * bundle at runtime. The shape is derived from the real API object, so the two
 * cannot drift.
 */
declare global {
  interface Window {
    readonly lectern: LecternApi
  }
}

export {}
