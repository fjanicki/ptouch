// A lazily imported module (icon catalogue, table renderer): loaded once per page, concurrent
// calls share the request, a failed import is retried on the next call.
export function lazyModule<T>(load: () => Promise<T>): [get: () => Promise<T>, loaded: () => T | undefined] {
  let set: T | undefined
  let pending: Promise<T> | undefined
  const get = (): Promise<T> =>
    set
      ? Promise.resolve(set)
      : (pending ??= load().then(
          (m) => (set = m),
          (e: unknown) => {
            pending = undefined
            throw e
          },
        ))
  return [get, () => set]
}
