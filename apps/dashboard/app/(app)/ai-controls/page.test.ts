import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'app/(app)/ai-controls/page.tsx'), 'utf8')

describe('Venue Bot settings route boundary', () => {
  it('loads the canonical configuration API and does not revive legacy AI controls', () => {
    expect(source).toContain('getBotConfiguration')
    expect(source).toContain('listPersonalityProfiles')
    expect(source).not.toContain('getAiConfig')
    expect(source).not.toContain('place.list')
  })

  it('shows the provisional Tochi asset only behind every rollout gate', () => {
    expect(source).toContain("isFeatureEnabled('venueCharacterMode')")
    expect(source).toContain("isFeatureEnabled('characterRegistry')")
    expect(source).toContain("isFeatureEnabled('tochiVenueCharacter')")
    expect(source).toContain('assets/characters/tochi/v0-development/manifest.json')
    expect(source).toContain('selectionPreviewAssetId')
  })

  it('keeps Venue Bot distinct from the private client assistant', () => {
    expect(source).toContain('Venue Bot is separate')
    expect(source).toContain('private client portal')
    expect(source).not.toContain('Your Torchiko')
  })
})
