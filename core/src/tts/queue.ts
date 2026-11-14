// Single-consumer async queue: items in order, then either a clean end or an error.
// Items already queued are delivered before a terminal error is thrown.
type Terminal = { kind: 'end' } | { kind: 'error'; error: Error }

export class AsyncQueue<T> {
  private items: T[] = []
  private terminal: Terminal | null = null
  private waiter: ((r: IteratorResult<T>) => void) | null = null
  private waiterError: ((e: Error) => void) | null = null

  push(value: T): void {
    if (this.terminal) return
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      this.waiterError = null
      resolve({ done: false, value })
      return
    }
    this.items.push(value)
  }

  end(): void {
    this.close({ kind: 'end' })
  }

  fail(error: Error): void {
    this.close({ kind: 'error', error })
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift() as T })
    }
    if (this.terminal) return this.settle(this.terminal)
    return new Promise((resolve, reject) => {
      this.waiter = resolve
      this.waiterError = reject
    })
  }

  private close(t: Terminal): void {
    if (this.terminal) return
    this.terminal = t
    if (this.waiter && this.items.length === 0) {
      const resolve = this.waiter
      const reject = this.waiterError
      this.waiter = null
      this.waiterError = null
      if (t.kind === 'error') reject?.(t.error)
      else resolve({ done: true, value: undefined })
    }
  }

  private settle(t: Terminal): Promise<IteratorResult<T>> {
    if (t.kind === 'error') return Promise.reject(t.error)
    return Promise.resolve({ done: true, value: undefined })
  }
}
