export interface LibraryRootCandidates {
  readonly environment: string | undefined
  readonly stored: string | null
  readonly storedExists: boolean
  readonly fallback: string
  readonly fallbackExists: boolean
}

export type LibraryRootDecision =
  | { readonly source: 'environment' | 'stored' | 'fallback'; readonly path: string }
  | { readonly source: 'picker' }

/** Decide the root without touching Electron or the filesystem. */
export function decideLibraryRoot(candidates: LibraryRootCandidates): LibraryRootDecision {
  if (candidates.environment) {
    return { source: 'environment', path: candidates.environment }
  }
  if (candidates.stored && candidates.storedExists) {
    return { source: 'stored', path: candidates.stored }
  }
  if (candidates.fallbackExists) {
    return { source: 'fallback', path: candidates.fallback }
  }
  return { source: 'picker' }
}
