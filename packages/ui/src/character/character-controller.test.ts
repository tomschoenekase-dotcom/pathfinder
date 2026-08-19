import { describe, expect, it } from 'vitest'

import {
  characterControllerReducer,
  clampCharacterIntensity,
  clampCharacterLookAt,
  createCharacterControllerState,
} from './character-controller'

describe('character controller', () => {
  it('clamps pointer and intensity input to renderer-safe bounds', () => {
    expect(clampCharacterLookAt({ x: 8, y: -4 })).toEqual({ x: 1, y: -1 })
    expect(clampCharacterLookAt({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual({
      x: 0,
      y: 0,
    })
    expect(clampCharacterIntensity(4)).toBe(1)
    expect(clampCharacterIntensity(-2)).toBe(0)
    expect(clampCharacterIntensity(Number.NaN)).toBe(0.6)
  })

  it('prevents a stale delayed reset from overwriting a newer state', () => {
    const initial = createCharacterControllerState()
    const thinking = characterControllerReducer(initial, {
      type: 'set-state',
      state: 'thinking',
    })
    const success = characterControllerReducer(thinking, {
      type: 'set-state',
      state: 'success',
    })

    expect(
      characterControllerReducer(success, {
        type: 'settle',
        state: 'idle',
        token: thinking.transitionToken,
      }),
    ).toBe(success)
    expect(
      characterControllerReducer(success, {
        type: 'settle',
        state: 'idle',
        token: success.transitionToken,
      }).state,
    ).toBe('idle')
  })

  it('tracks manual and visibility pause reasons independently', () => {
    const initial = createCharacterControllerState()
    const hidden = characterControllerReducer(initial, {
      type: 'document-visibility',
      hidden: true,
    })
    const manuallyPaused = characterControllerReducer(hidden, { type: 'pause', paused: true })
    const visible = characterControllerReducer(manuallyPaused, {
      type: 'document-visibility',
      hidden: false,
    })

    expect(visible.manuallyPaused).toBe(true)
    expect(visible.documentHidden).toBe(false)
  })
})
