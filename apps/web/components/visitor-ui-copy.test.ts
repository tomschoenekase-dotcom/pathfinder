import { describe, expect, it } from 'vitest'
import { SUPPORTED_CHAT_LANGUAGES } from '@pathfinder/api/schemas'
import {
  getVisitorPendingCopy,
  getVisitorRecoveryCopy,
  localizeVisitorShellError,
} from './visitor-ui-copy'

describe('visitor recovery presentation copy', () => {
  it('removes the retired profile reference without changing record-retention meaning or tuple positions', () => {
    expect(getVisitorRecoveryCopy('English')[10]).toBe(
      'Clear chat? The current chat will leave this screen, but it will not be deleted from Torchiko records.',
    )
    for (const language of SUPPORTED_CHAT_LANGUAGES) {
      expect(getVisitorRecoveryCopy(language.label)).toHaveLength(15)
      expect(getVisitorRecoveryCopy(language.label)[10]).toContain('Torchiko')
    }
  })

  it.each(SUPPORTED_CHAT_LANGUAGES)(
    'has explicit pending/access/storage copy for $label',
    ({ label }) => {
      const copy = getVisitorPendingCopy(label)
      for (const value of Object.values(copy)) expect(value.trim().length).toBeGreaterThan(0)
      const english = getVisitorPendingCopy('English')
      for (const key of ['accessUnavailable', 'storageUnavailable'] as const) {
        expect(localizeVisitorShellError(english[key], label)).toBe(copy[key])
        if (label !== 'English') expect(copy[key]).not.toBe(english[key])
      }
    },
  )

  it('keeps the bounded existing error mapper; it does not invent translations for arbitrary text', () => {
    expect(localizeVisitorShellError(null, '日本語')).toBeNull()
    expect(localizeVisitorShellError('Unknown safe message.', 'العربية')).toBe(
      'Unknown safe message.',
    )
  })
})
