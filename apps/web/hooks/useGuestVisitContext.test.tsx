import { act, renderHook, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { describe, expect, it } from 'vitest'

import { useGuestVisitContext } from './useGuestVisitContext'

const emptyContext = { visitedPlaceIds: [], interests: [] }

describe('useGuestVisitContext', () => {
  it.each([
    { label: 'an initially unavailable venue', venueId: '', scope: 'public' },
    { label: 'another experience scope', venueId: 'venue_1', scope: 'employee' },
  ])('retains an accepted pre-passive update after $label becomes current', (initial) => {
    const accepted: boolean[] = []
    const preferences = { visitedPlaceIds: ['place-1'], interests: ['trains'] }
    const visit = renderHook(
      ({ venueId, scope }) => {
        const output = useGuestVisitContext(venueId, scope)
        const updateContext = output.updateContext
        useLayoutEffect(() => {
          if (venueId === 'venue_1' && scope === 'public' && accepted.length === 0) {
            accepted.push(updateContext(preferences))
          }
        }, [scope, updateContext, venueId])
        return output
      },
      { initialProps: { venueId: initial.venueId, scope: initial.scope } },
    )
    const staleUpdate = visit.result.current.updateContext
    const staleClear = visit.result.current.clearVisit

    visit.rerender({ venueId: 'venue_1', scope: 'public' })

    expect(accepted).toEqual([true])
    expect(visit.result.current.context).toEqual(preferences)
    act(() => {
      expect(staleUpdate({ visitedPlaceIds: [], interests: ['stale'] })).toBe(false)
      expect(staleClear()).toBe(false)
    })
    expect(visit.result.current.context).toEqual(preferences)
    const beforeFreshVisit = visit.result.current.updateContext
    act(() => expect(visit.result.current.clearVisit()).toBe(true))
    expect(visit.result.current.context).toEqual(emptyContext)
    act(() => expect(beforeFreshVisit(preferences)).toBe(false))
    expect(visit.result.current.context).toEqual(emptyContext)
  })

  it('retains a new accepted input before a fresh visit passive reset', () => {
    const accepted: boolean[] = []
    const replacement = { visitedPlaceIds: [], interests: ['architecture'] }
    const visit = renderHook(
      ({ replace }) => {
        const output = useGuestVisitContext('venue_1')
        const updateContext = output.updateContext
        useLayoutEffect(() => {
          if (replace) accepted.push(updateContext(replacement))
        }, [replace, updateContext])
        return output
      },
      { initialProps: { replace: false } },
    )
    act(() => {
      expect(
        visit.result.current.updateContext({ visitedPlaceIds: [], interests: ['trains'] }),
      ).toBe(true)
    })
    const priorVisitUpdate = visit.result.current.updateContext
    act(() => {
      expect(visit.result.current.clearVisit()).toBe(true)
      visit.rerender({ replace: true })
    })

    expect(accepted).toEqual([true])
    expect(visit.result.current.context).toEqual(replacement)
    act(() => expect(priorVisitUpdate({ visitedPlaceIds: [], interests: ['stale'] })).toBe(false))
    expect(visit.result.current.context).toEqual(replacement)
  })

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
