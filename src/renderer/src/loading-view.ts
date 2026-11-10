const generations = new WeakMap<HTMLElement, number>()

/** Show only chapter opens slow enough to be perceptible. */
export function beginDelayedLoading(
  indicator: HTMLElement | null,
  delay = 200
): () => void {
  if (!indicator) return () => undefined

  const generation = (generations.get(indicator) ?? 0) + 1
  generations.set(indicator, generation)
  const timer = setTimeout(() => {
    if (generations.get(indicator) === generation) indicator.hidden = false
  }, delay)

  return () => {
    clearTimeout(timer)
    if (generations.get(indicator) !== generation) return
    indicator.hidden = true
  }
}
