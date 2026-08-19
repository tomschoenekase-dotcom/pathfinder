'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import type { CharacterState } from '@pathfinder/contracts/character-system'

import type { CharacterMotion } from './character-types'

export const DEFAULT_CHARACTER_REACTION_DURATION_MS = 1_200

export type CharacterLookAt = { x: number; y: number }

export type CharacterControllerState = {
  state: CharacterState
  lookAt: CharacterLookAt
  intensity: number
  manuallyPaused: boolean
  documentHidden: boolean
  transitionToken: number
}

export type CharacterControllerAction =
  | { type: 'set-state'; state: CharacterState }
  | { type: 'settle'; state: CharacterState; token: number }
  | { type: 'look-at'; value: CharacterLookAt }
  | { type: 'set-intensity'; value: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'document-visibility'; hidden: boolean }
  | { type: 'reset'; state: CharacterState }

export type CharacterReactionOptions = {
  settleTo?: CharacterState
  durationMs?: number
}

export type UseCharacterControllerOptions = {
  initialState?: CharacterState
  initialIntensity?: number
  initialLookAt?: CharacterLookAt
  motion?: CharacterMotion
}

function clamp(value: number, minimum: number, maximum: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

export function clampCharacterLookAt(value: CharacterLookAt): CharacterLookAt {
  return {
    x: clamp(value.x, -1, 1, 0),
    y: clamp(value.y, -1, 1, 0),
  }
}

export function clampCharacterIntensity(value: number) {
  return clamp(value, 0, 1, 0.6)
}

export function createCharacterControllerState(
  options: UseCharacterControllerOptions = {},
): CharacterControllerState {
  return {
    state: options.initialState ?? 'idle',
    lookAt: clampCharacterLookAt(options.initialLookAt ?? { x: 0, y: 0 }),
    intensity: clampCharacterIntensity(options.initialIntensity ?? 0.6),
    manuallyPaused: false,
    documentHidden: false,
    transitionToken: 0,
  }
}

export function characterControllerReducer(
  current: CharacterControllerState,
  action: CharacterControllerAction,
): CharacterControllerState {
  switch (action.type) {
    case 'set-state':
      return {
        ...current,
        state: action.state,
        transitionToken: current.transitionToken + 1,
      }
    case 'settle':
      if (action.token !== current.transitionToken) return current
      return { ...current, state: action.state }
    case 'look-at':
      return { ...current, lookAt: clampCharacterLookAt(action.value) }
    case 'set-intensity':
      return { ...current, intensity: clampCharacterIntensity(action.value) }
    case 'pause':
      return { ...current, manuallyPaused: action.paused }
    case 'document-visibility':
      return { ...current, documentHidden: action.hidden }
    case 'reset':
      return {
        ...createCharacterControllerState({ initialState: action.state }),
        transitionToken: current.transitionToken + 1,
      }
  }
}

function useReducedMotionPreference() {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return reduced
}

export function useCharacterController(options: UseCharacterControllerOptions = {}) {
  const initialStateRef = useRef(options.initialState ?? 'idle')
  const [snapshot, dispatch] = useReducer(
    characterControllerReducer,
    options,
    createCharacterControllerState,
  )
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prefersReducedMotion = useReducedMotionPreference()

  const cancelPendingReaction = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const setState = useCallback(
    (state: CharacterState) => {
      cancelPendingReaction()
      dispatch({ type: 'set-state', state })
    },
    [cancelPendingReaction],
  )

  const react = useCallback(
    (state: CharacterState, reactionOptions: CharacterReactionOptions = {}) => {
      cancelPendingReaction()
      dispatch({ type: 'set-state', state })
      const token = snapshot.transitionToken + 1
      const durationMs = Math.max(
        0,
        Math.min(30_000, reactionOptions.durationMs ?? DEFAULT_CHARACTER_REACTION_DURATION_MS),
      )
      timerRef.current = setTimeout(() => {
        dispatch({
          type: 'settle',
          state: reactionOptions.settleTo ?? 'idle',
          token,
        })
        timerRef.current = null
      }, durationMs)
    },
    [cancelPendingReaction, snapshot.transitionToken],
  )

  const lookAt = useCallback((value: CharacterLookAt) => {
    dispatch({ type: 'look-at', value })
  }, [])

  const setIntensity = useCallback((value: number) => {
    dispatch({ type: 'set-intensity', value })
  }, [])

  const pause = useCallback((paused = true) => {
    dispatch({ type: 'pause', paused })
  }, [])

  const reset = useCallback(() => {
    cancelPendingReaction()
    dispatch({ type: 'reset', state: initialStateRef.current })
  }, [cancelPendingReaction])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const update = () => dispatch({ type: 'document-visibility', hidden: document.hidden })
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => cancelPendingReaction, [cancelPendingReaction])

  const paused = snapshot.manuallyPaused || snapshot.documentHidden
  const requestedMotion = options.motion ?? 'system'
  const motion: CharacterMotion =
    paused ||
    requestedMotion === 'reduced' ||
    (requestedMotion === 'system' && prefersReducedMotion)
      ? 'reduced'
      : requestedMotion

  return useMemo(
    () => ({
      ...snapshot,
      paused,
      motion,
      prefersReducedMotion,
      setState,
      react,
      lookAt,
      setIntensity,
      pause,
      reset,
    }),
    [
      lookAt,
      motion,
      pause,
      paused,
      prefersReducedMotion,
      react,
      reset,
      setIntensity,
      setState,
      snapshot,
    ],
  )
}
