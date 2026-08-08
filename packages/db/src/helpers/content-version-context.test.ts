import { describe, expect, it, vi } from 'vitest'

import { setContentVersionContext } from './content-version-context'

const packageContext = {
  venuePackageId: 'cpackage12345678901234',
  itemKey: '11111111-1111-4111-8111-111111111111',
  action: 'APPLY' as const,
  sourceProvenance: {
    sourceType: 'venue-package-json',
    sourceName: 'Reviewed onboarding package',
    sourceUrl: 'https://example.test/source.json',
    contentOrigin: 'AI_GENERATED' as const,
    importedAt: '2026-08-08T16:00:00.000Z',
    humanConfirmedAt: '2026-08-08T16:01:00.000Z',
    lastReviewedAt: '2026-08-08T16:01:00.000Z',
  },
}

describe('setContentVersionContext', () => {
  it('sets and clears every package-provenance value transaction-locally', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1)
    const tx = { $executeRaw: executeRaw }

    await setContentVersionContext(tx, {
      actorId: 'actor-1',
      venuePackage: packageContext,
    })
    expect(executeRaw).toHaveBeenCalledTimes(6)
    expect(executeRaw.mock.calls.map((call) => call.slice(1))).toEqual([
      ['actor-1'],
      [''],
      [packageContext.venuePackageId],
      [packageContext.itemKey],
      [packageContext.action],
      [JSON.stringify(packageContext.sourceProvenance)],
    ])

    executeRaw.mockClear()
    await setContentVersionContext(tx, { actorId: 'actor-2' })
    expect(executeRaw.mock.calls.map((call) => call.slice(1))).toEqual([
      ['actor-2'],
      [''],
      [''],
      [''],
      [''],
      [''],
    ])
  })

  it('rejects malformed provenance before mutating transaction context', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1)
    const tx = { $executeRaw: executeRaw }

    await expect(
      setContentVersionContext(tx, {
        actorId: 'actor-1',
        venuePackage: {
          ...packageContext,
          sourceProvenance: {
            ...packageContext.sourceProvenance,
            sourceUrl: 'javascript:alert(1)',
          },
        },
      }),
    ).rejects.toThrow(/HTTP\(S\)/u)
    expect(executeRaw).not.toHaveBeenCalled()

    await expect(
      setContentVersionContext(tx, {
        actorId: 'actor-1',
        venuePackage: {
          ...packageContext,
          sourceProvenance: {
            ...packageContext.sourceProvenance,
            sourceUrl: 'https://token@example.test/source.json',
          },
        },
      }),
    ).rejects.toThrow(/no credentials/u)
    expect(executeRaw).not.toHaveBeenCalled()

    await expect(
      setContentVersionContext(tx, {
        actorId: 'actor-1',
        venuePackage: {
          ...packageContext,
          sourceProvenance: {
            ...packageContext.sourceProvenance,
            sourceUrl: 'https://example.test/source.json?x-amz-signature=secret',
          },
        },
      }),
    ).rejects.toThrow(/no credentials/u)
    expect(executeRaw).not.toHaveBeenCalled()

    for (const sourceUrl of [
      'https://example.test/source.json?sig=azure-sas-secret',
      'https://example.test/source.json#access_token=oauth-secret',
      'https://example.test/source.json?%73ig=encoded-secret',
      'https://example.test/source.json?access_%74oken=encoded-secret',
    ]) {
      await expect(
        setContentVersionContext(tx, {
          actorId: 'actor-1',
          venuePackage: {
            ...packageContext,
            sourceProvenance: { ...packageContext.sourceProvenance, sourceUrl },
          },
        }),
      ).rejects.toThrow(/no credentials/u)
      expect(executeRaw).not.toHaveBeenCalled()
    }
  })
})
