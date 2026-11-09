/** Coalesce repeated requests into one trailing action. */
export function coalesceAction(action: () => void, delayMs: number): {
  request: () => void
  flush: () => void
  cancel: () => void
} {
  let pending = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = (): void => {
    timer = null
    if (!pending) return
    pending = false
    action()
  }

  return {
    request: () => {
      pending = true
      timer ??= setTimeout(run, delayMs)
    },
    flush: () => {
      if (timer) clearTimeout(timer)
      run()
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
      pending = false
    }
  }
}

/** Map synchronously expensive work in bounded chunks, yielding between them. */
export async function mapInChunks<T, U>(
  items: readonly T[],
  chunkSize: number,
  transform: (item: T) => U,
  yieldBetween: () => Promise<void>
): Promise<U[]> {
  if (chunkSize < 1) throw new RangeError('chunkSize must be positive')

  const result: U[] = []
  for (let start = 0; start < items.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, items.length)
    for (let at = start; at < end; at += 1) result.push(transform(items[at] as T))
    if (end < items.length) await yieldBetween()
  }
  return result
}
