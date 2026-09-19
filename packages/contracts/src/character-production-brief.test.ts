import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  CharacterProductionBriefSchema,
  createCharacterProductionPrompt,
} from './character-production-brief'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const tochiBrief = JSON.parse(
  readFileSync(
    path.join(repositoryRoot, 'assets/characters/tochi/production-brief-v1.json'),
    'utf8',
  ),
)

describe('character production brief', () => {
  it('binds the approved Tochi identity without claiming generation or publication', () => {
    const parsed = CharacterProductionBriefSchema.parse(tochiBrief)
    expect(parsed.approvedReference.sha256).toBe(
      '2d7b768e2c93636b387377967fd3bc99525f2e4c57ac3213e6039d8aa8068a60',
    )
    expect(parsed.creation.automaticGenerationAvailable).toBe(false)
    expect(parsed.review).toMatchObject({ humanApprovalRequired: true, publishable: false })
    expect(parsed.identity.lockedTraits).toContain('asymmetric multi-lobed flame silhouette')
  })

  it('creates a provider-neutral prompt that requires the actual reference image', () => {
    const prompt = createCharacterProductionPrompt(tochiBrief)
    expect(prompt).toContain('Attach TorchikoBotReferenceImages.png')
    expect(prompt).toContain('do not claim reference-conditioned generation')
    expect(prompt).toContain('Accepted master formats: image/png, image/svg+xml')
    expect(prompt).toContain('Transparent background: preferred')
    expect(prompt).toContain('Optional effects on separate layers: required')
    expect(prompt).toContain('Do not publish or replace any active character')
  })

  it('rejects an overclaimed ready-to-publish brief', () => {
    expect(
      CharacterProductionBriefSchema.safeParse({
        ...tochiBrief,
        creation: { ...tochiBrief.creation, automaticGenerationAvailable: true },
        review: { ...tochiBrief.review, publishable: true },
      }).success,
    ).toBe(false)
  })
})
