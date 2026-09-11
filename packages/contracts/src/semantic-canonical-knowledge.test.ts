import { describe, expect, it } from 'vitest'

import { hashSemanticCanonicalKnowledgeTarget } from './semantic-canonical-knowledge'

const target = {
  id: 'knowledge-1',
  title: 'Gallery hours',
  category: 'Hours',
  content: 'The gallery closes at 5 PM.',
  isEnabled: true,
  humanConfirmedAt: new Date('2026-09-10T11:00:00.000Z'),
  authorship: 'HUMAN_AUTHORED',
  sourceType: 'PATHFINDER_INTAKE',
}

describe('semantic canonical knowledge target hash', () => {
  it('is stable for an exact clone and uses the existing SHA-256 bytes', () => {
    const hash = hashSemanticCanonicalKnowledgeTarget(target)
    expect(hash).toBe('2ed0715970a943bb2bf3ebd02ba719ad763d1be3a7eaf783cb8adef7860d719a')
    expect(hashSemanticCanonicalKnowledgeTarget({ ...target })).toBe(hash)
  })

  it.each([
    { ...target, humanConfirmedAt: new Date('2026-09-10T11:01:00.000Z') },
    { ...target, authorship: 'AI_GENERATED' },
    { ...target, sourceType: 'PUBLIC_WEBSITE' },
  ])('changes for canonical metadata drift', (changed) => {
    expect(hashSemanticCanonicalKnowledgeTarget(changed)).not.toBe(
      hashSemanticCanonicalKnowledgeTarget(target),
    )
  })

  it.each([
    { ...target, extra: true },
    Object.assign(Object.create({ inherited: true }), target),
    [],
  ])('rejects malformed or nonplain input', (value) => {
    expect(() => hashSemanticCanonicalKnowledgeTarget(value as never)).toThrow()
  })
})
