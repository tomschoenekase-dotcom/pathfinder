import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useGuestVisitContext } from './useGuestVisitContext'

const emptyContext = { visitedPlaceIds: [], interests: [] }

describe('useGuestVisitContext', () => {
  it('keeps explicit context only in the current venue and experience scope', async () => {
    const capturedContexts: Array<{ visitedPlaceIds: string[]; interests: string[] }> = []
    const visit = renderHook(
      ({ venueId, scope }) => {
        const output = useGuestVisitContext(venueId, scope)
        capturedContexts.push(output.context)
        return output
      },
      { initialProps: { venueId: 'venue_1', scope: 'public' } },
    )
    await waitFor(() => expect(visit.result.current.context).toEqual(emptyContext))
    act(() => {
      expect(
        visit.result.current.updateContext({
          visitedPlaceIds: ['place-1'],
          interests: ['trains'],
          remainingMinutes: 20,
        }),
      ).toBe(true)
    })

    const beforeScopeSwitch = capturedContexts.length
    visit.rerender({ venueId: 'venue_1', scope: 'employee' })
    expect(capturedContexts[beforeScopeSwitch]).toEqual(emptyContext)
    await waitFor(() => expect(visit.result.current.context).toEqual(emptyContext))

    act(() => {
      expect(
        visit.result.current.updateContext({
          visitedPlaceIds: ['employee-place'],
          interests: [],
        }),
      ).toBe(true)
    })
    visit.rerender({ venueId: 'venue_2', scope: 'employee' })
    await waitFor(() => expect(visit.result.current.context).toEqual(emptyContext))

    visit.rerender({ venueId: 'venue_1', scope: 'public' })
    await waitFor(() => expect(visit.result.current.context).toEqual(emptyContext))
  })

  it('fences callbacks captured before a scope switch', async () => {
    const visit = renderHook(({ scope }) => useGuestVisitContext('venue_1', scope), {
      initialProps: { scope: 'public' },
    })
    await waitFor(() => expect(visit.result.current.context).toEqual(emptyContext))
    const staleUpdate = visit.result.current.updateContext
    const staleClear = visit.result.current.clearVisit

    visit.rerender({ scope: 'employee' })
    await waitFor(() => expect(visit.result.current.context).toEqual(emptyContext))
    act(() => {
      expect(staleUpdate({ visitedPlaceIds: ['wrong-scope-place'], interests: ['private'] })).toBe(
        false,
      )
      expect(staleClear()).toBe(false)
    })
    expect(visit.result.current.context).toEqual(emptyContext)
  })

  it('clears a fresh visit and invalidates callbacks from the prior visit', async () => {
    const visit = renderHook(() => useGuestVisitContext('venue_1'))
    await waitFor(() => expect(visit.result.current.context).toEqual(emptyContext))

    act(() => {
      expect(
        visit.result.current.updateContext({
          visitedPlaceIds: ['place-1'],
          interests: ['trains'],
        }),
      ).toBe(true)
    })
    const priorVisitUpdate = visit.result.current.updateContext
    act(() => expect(visit.result.current.clearVisit()).toBe(true))

    expect(visit.result.current.context).toEqual(emptyContext)
    act(() =>
      expect(priorVisitUpdate({ visitedPlaceIds: ['stale-place'], interests: [] })).toBe(false),
    )
    expect(visit.result.current.context).toEqual(emptyContext)
  })

  it('rejects invalid explicit input without mutating the active context', async () => {
    const visit = renderHook(() => useGuestVisitContext('venue_1'))
    await waitFor(() => expect(visit.result.current.context).toEqual(emptyContext))
    act(() => {
      expect(
        visit.result.current.updateContext({
          visitedPlaceIds: ['place-1'],
          interests: ['architecture'],
        }),
      ).toBe(true)
    })

    act(() => {
      expect(
        visit.result.current.updateContext({
          visitedPlaceIds: [],
          interests: [],
          transcript: ['private raw history'],
        } as never),
      ).toBe(false)
    })
    expect(visit.result.current.context).toEqual({
      visitedPlaceIds: ['place-1'],
      interests: ['architecture'],
    })
  })

  it('does not infer visits or retain context after unmount', async () => {
    const first = renderHook(() => useGuestVisitContext('venue_1'))
    await waitFor(() => expect(first.result.current.context).toEqual(emptyContext))
    act(() => {
      first.result.current.updateContext({ visitedPlaceIds: ['place-1'], interests: [] })
    })
    first.unmount()

    const second = renderHook(() => useGuestVisitContext('venue_1'))
    await waitFor(() => expect(second.result.current.context).toEqual(emptyContext))
  })
})
