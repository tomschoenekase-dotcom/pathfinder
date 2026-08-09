import { describe, expect, it } from 'vitest'

import { FEATURE_FLAGS, isEmbedPreviewEnabled } from './feature-flags'

describe('embed preview feature boundary', () => {
  it('is documented as default-off', () => {
    expect(FEATURE_FLAGS.embedPreview).toEqual({
      environmentVariable: 'EMBED_PREVIEW_ENABLED',
      defaultEnabled: false,
    })
  })

  it('enables only for the exact true value', () => {
    expect(isEmbedPreviewEnabled({})).toBe(false)
    expect(isEmbedPreviewEnabled({ EMBED_PREVIEW_ENABLED: 'false' })).toBe(false)
    expect(isEmbedPreviewEnabled({ EMBED_PREVIEW_ENABLED: 'TRUE' })).toBe(false)
    expect(isEmbedPreviewEnabled({ EMBED_PREVIEW_ENABLED: 'true' })).toBe(true)
  })
})
