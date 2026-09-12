'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  GuestVisitContextInput,
  type GuestVisitContextInput as GuestVisitContext,
} from '@pathfinder/contracts/guest-visit-context'

const EMPTY_CONTEXT: GuestVisitContext = { visitedPlaceIds: [], interests: [] }

type GuestVisitContextState = {
  scopeKey: string
  lifecycle: number
  context: GuestVisitContext
}

export type GuestVisitContextHook = {
  context: GuestVisitContext
  updateContext: (input: GuestVisitContext) => boolean
  clearVisit: () => boolean
}

export function useGuestVisitContext(
  venueId: string,
  experienceScope = 'public',
): GuestVisitContextHook {
  const scopeKey = `${venueId}\u0000${experienceScope}`
  const [state, setState] = useState<GuestVisitContextState>({
    scopeKey: '',
    lifecycle: -1,
    context: EMPTY_CONTEXT,
  })
  const lifecycleRef = useRef(0)
  const scopeKeyRef = useRef(scopeKey)

  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey
    lifecycleRef.current += 1
  }
  const lifecycle = lifecycleRef.current

  useEffect(() => {
    setState((previous) => {
      if (scopeKeyRef.current !== scopeKey || lifecycleRef.current !== lifecycle) return previous
      // A current callback may have saved before this passive initializer runs.
      return previous.scopeKey === scopeKey && previous.lifecycle === lifecycle
        ? previous
        : { scopeKey, lifecycle, context: EMPTY_CONTEXT }
    })
  }, [lifecycle, scopeKey])

  const updateContext = useCallback(
    (input: GuestVisitContext) => {
      if (!venueId || scopeKeyRef.current !== scopeKey || lifecycleRef.current !== lifecycle) {
        return false
      }

      const parsed = GuestVisitContextInput.safeParse(input)
      if (!parsed.success) return false
      const context = parsed.data
      setState((previous) =>
        scopeKeyRef.current === scopeKey && lifecycleRef.current === lifecycle
          ? { scopeKey, lifecycle, context }
          : previous,
      )
      return true
    },
    [lifecycle, scopeKey, venueId],
  )

  const clearVisit = useCallback(() => {
    if (!venueId || scopeKeyRef.current !== scopeKey || lifecycleRef.current !== lifecycle) {
      return false
    }

    lifecycleRef.current += 1
    setState({ scopeKey, lifecycle: lifecycleRef.current, context: EMPTY_CONTEXT })
    return true
  }, [lifecycle, scopeKey, venueId])

  return {
    context:
      state.scopeKey === scopeKey && state.lifecycle === lifecycle ? state.context : EMPTY_CONTEXT,
    updateContext,
    clearVisit,
  }
}
