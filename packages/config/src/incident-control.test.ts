import { describe, expect, it } from 'vitest'

import {
  DEFAULT_GLOBAL_AI_CONTROL,
  GLOBAL_AI_CONTROL_KEY,
  GLOBAL_AI_UNAVAILABLE_MESSAGE,
  parseGlobalAiControlValue,
} from './incident-control'

describe('global AI incident-control contract', () => {
  it('uses one versioned platform key and an active missing-row default', () => {
    expect(GLOBAL_AI_CONTROL_KEY).toBe('global-ai-control-v1')
    expect(DEFAULT_GLOBAL_AI_CONTROL).toEqual({ schemaVersion: 1, paused: false, reason: null })
    expect(GLOBAL_AI_UNAVAILABLE_MESSAGE).not.toMatch(/reason|database|config/iu)
  })

  it('accepts only the exact bounded value contract', () => {
    expect(
      parseGlobalAiControlValue({ schemaVersion: 1, paused: true, reason: 'Provider incident' }),
    ).toEqual({ schemaVersion: 1, paused: true, reason: 'Provider incident' })
    expect(parseGlobalAiControlValue({ schemaVersion: 1, paused: false, reason: null })).toEqual({
      schemaVersion: 1,
      paused: false,
      reason: null,
    })
    expect(parseGlobalAiControlValue({ schemaVersion: 2, paused: true, reason: null })).toBeNull()
    expect(
      parseGlobalAiControlValue({ schemaVersion: 1, paused: true, reason: null, extra: true }),
    ).toBeNull()
    expect(parseGlobalAiControlValue({ schemaVersion: 1, paused: 'true', reason: null })).toBeNull()
    expect(
      parseGlobalAiControlValue({ schemaVersion: 1, paused: true, reason: 'x'.repeat(501) }),
    ).toBeNull()
  })
})
