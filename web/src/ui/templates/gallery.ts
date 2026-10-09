// P2 — helpers of the template gallery (pure, unit-tested): arrow-key movement in a wrapping
// card grid, and a small task queue that bounds how many thumbnails render at once.

/** Card centre in viewport px (getBoundingClientRect). */
export interface CardPoint {
  x: number
  y: number
}

/** Cards whose centres differ by less than this (px) are on the same row. */
const ROW_TOLERANCE = 4

/**
 * The card to focus after `key` on card `from`. Left/Right step through the cards in order,
 * Up/Down move to the nearest card (by x) in the closest row above/below, which also crosses
 * from one section to the next, and Home/End jump to the first/last card. Returns `from` when
 * there is nowhere to go, or -1 when `key` is not a navigation key.
 */
export function gridMove(cards: readonly CardPoint[], from: number, key: string): number {
  const last = cards.length - 1
  const here = cards[from]
  if (!here) return -1
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, from - 1)
    case 'ArrowRight':
      return Math.min(last, from + 1)
    case 'Home':
      return 0
    case 'End':
      return last
    case 'ArrowUp':
    case 'ArrowDown': {
      const dir = key === 'ArrowDown' ? 1 : -1
      let best = from
      let bestDy = Infinity
      let bestDx = Infinity
      cards.forEach((c, i) => {
        const dy = (c.y - here.y) * dir
        if (dy <= ROW_TOLERANCE) return
        const dx = Math.abs(c.x - here.x)
        // The closest row first (within the tolerance), then the closest card in it.
        if (dy < bestDy - ROW_TOLERANCE || (Math.abs(dy - bestDy) <= ROW_TOLERANCE && dx < bestDx)) {
          best = i
          bestDy = dy
          bestDx = dx
        }
      })
      return best
    }
    default:
      return -1
  }
}

export interface TaskQueue {
  /** Runs `task` when a slot is free. Rejects with an AbortError (without running the task) when
   * `signal` aborts while it waits. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>
  /** Tasks running right now (tests). */
  readonly active: number
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

/** At most `concurrency` tasks at a time, first come first served. */
export function createTaskQueue(concurrency: number): TaskQueue {
  let active = 0
  const waiting: (() => void)[] = []
  const next = () => {
    if (active >= concurrency) return
    const start = waiting.shift()
    if (start) start()
  }
  return {
    get active() {
      return active
    },
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError())
        const start = () => {
          signal?.removeEventListener('abort', onAbort)
          active++
          task()
            .then(resolve, reject)
            .finally(() => {
              active--
              next()
            })
        }
        const onAbort = () => {
          const i = waiting.indexOf(start)
          if (i >= 0) waiting.splice(i, 1)
          reject(abortError())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiting.push(start)
        next()
      })
    },
  }
}
