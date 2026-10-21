import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

export type GuestQueryTimingSpan = {
  id: number
  parentId: number | null
  stage: string
  startMs: number
  endMs: number
  inclusiveMs: number
  selfMs: number
  outcome: 'RETURNED' | 'THREW'
}

type ActiveSpan = { id: number; children: Array<[number, number]> }
type TimingContext = {
  spans: GuestQueryTimingSpan[]
  parent?: ActiveSpan
  nextId: { value: number }
}
const timing = new AsyncLocalStorage<TimingContext>()

/** Explicit local opt-in only. Normal callers allocate no spans or clock readings. */
export async function captureGuestQueryTiming<T>(run: () => Promise<T>) {
  if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development')
    throw new Error('Guest query timing capture is local only')
  const context: TimingContext = { spans: [], nextId: { value: 0 } }
  const value = await timing.run(context, run)
  return { value, spans: context.spans.sort((a, b) => a.id - b.id) }
}

function begin(context: TimingContext, stage: string) {
  const active: ActiveSpan = { id: context.nextId.value++, children: [] }
  const startMs = performance.now()
  return {
    context: { ...context, parent: active },
    finish(outcome: GuestQueryTimingSpan['outcome']) {
      const endMs = performance.now()
      const inclusiveMs = endMs - startMs
      if (context.parent) context.parent.children.push([startMs, endMs])
      // Async children may overlap: subtract their interval union, never their sum.
      let childrenMs = 0
      let coveredUntil = startMs
      for (const [start, end] of active.children.sort((a, b) => a[0] - b[0])) {
        childrenMs += Math.max(0, end - Math.max(start, coveredUntil))
        coveredUntil = Math.max(coveredUntil, end)
      }
      context.spans.push({
        id: active.id,
        parentId: context.parent?.id ?? null,
        stage,
        startMs,
        endMs,
        inclusiveMs,
        selfMs: inclusiveMs - childrenMs,
        outcome,
      })
    },
  }
}

export function guestQueryTiming<T>(stage: string, run: () => T): T {
  const context = timing.getStore()
  if (!context) return run()
  const span = begin(context, stage)
  let outcome: GuestQueryTimingSpan['outcome'] = 'THREW'
  try {
    const value = timing.run(span.context, run)
    outcome = 'RETURNED'
    return value
  } finally {
    span.finish(outcome)
  }
}

export async function guestQueryTimingAsync<T>(stage: string, run: () => Promise<T>): Promise<T> {
  const context = timing.getStore()
  if (!context) return run()
  const span = begin(context, stage)
  let outcome: GuestQueryTimingSpan['outcome'] = 'THREW'
  try {
    const value = await timing.run(span.context, run)
    outcome = 'RETURNED'
    return value
  } finally {
    span.finish(outcome)
  }
}
