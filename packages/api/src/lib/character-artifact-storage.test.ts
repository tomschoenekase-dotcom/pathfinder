import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCharacterBundle,
  FACTORY_STATES,
  type CharacterSpec,
} from '@pathfinder/character-factory'
import {
  createCharacterArtifactStorage,
  CharacterArtifactStorageError,
} from './character-artifact-storage'

async function fixture() {
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>',
  )
  const spec: CharacterSpec = {
    schemaVersion: 1,
    characterId: 'talking-tablet',
    version: 1,
    revision: 1,
    displayName: 'Talking tablet',
    rigFamily: 'custom:talking-tablet-v1',
    rigCapabilities: {
      schemaVersion: 1,
      familyId: 'custom:talking-tablet-v1',
      anatomyClass: 'object',
      requiredSlots: ['screen'],
      stateControls: { speaking: ['mouth'] },
    },
    source: {
      kind: 'imported',
      sourceUrl: 'https://example.test/tablet.svg',
      sourceRevision: 'fixture-1',
      license: 'CC0',
      attribution: 'Fixture',
      importedAt: '2026-09-07T00:00:00.000Z',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'image/svg+xml',
      byteLength: bytes.byteLength,
    },
    masterReference: 'source/tablet.svg',
    protectedTraits: ['screen'],
    slotMap: { screen: 'screen' },
    supportedStates: FACTORY_STATES,
    status: 'exported',
  }
  return {
    spec,
    artifact: await createCharacterBundle(spec, [
      { path: 'source/tablet.svg', mediaType: 'image/svg+xml', bytes, role: 'master' },
      { path: 'slots/screen.svg', mediaType: 'image/svg+xml', bytes, role: 'slot', slot: 'screen' },
      { path: 'fallback/tablet.svg', mediaType: 'image/svg+xml', bytes, role: 'fallback' },
    ]),
  }
}

describe('character artifact storage boundaries', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects cross-tenant references before reading storage', async () => {
    const { artifact } = await fixture()
    let sends = 0
    const transport = {
      send: async (command: object) => {
        sends++
        if (command.constructor.name === 'PutObjectCommand') return { VersionId: 'fixture-version' }
        return {
          Body: (async function* () {
            yield artifact.bytes
          })(),
          ContentLength: artifact.byteLength,
          ContentType: artifact.mediaType,
          Metadata: { 'pathfinder-sha256': artifact.sha256 },
        }
      },
    }
    const storage = createCharacterArtifactStorage(transport, 'fixture-bucket')
    const reference = await storage.put({ tenantId: 'tenant-a', venueId: 'venue-a', artifact })
    sends = 0
    await expect(
      storage.getVerified({ tenantId: 'tenant-b', venueId: 'venue-a', reference }),
    ).rejects.toBeInstanceOf(CharacterArtifactStorageError)
    expect(sends).toBe(0)
  })

  it('retains immutable final blobs when a job is cancelled', async () => {
    const storage = createCharacterArtifactStorage({ send: async () => ({}) }, 'fixture-bucket')
    expect(storage.cleanupCancelled({ arbitrary: 'unknown object' })).toEqual({
      disposition: 'retained-content-addressed',
    })
  })

  it('destroys a stalled response without waiting for iterator return', async () => {
    vi.useFakeTimers()
    const { artifact } = await fixture()
    const destroy = vi.fn()
    const body = {
      destroy,
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    }
    const reference = {
      kind: 'character-bundle-v1' as const,
      bucket: 'fixture-bucket',
      objectKey: `character-factory/tenant-a/venue-a/${artifact.characterId}/v1/${artifact.sha256}.character.json`,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      mediaType: artifact.mediaType,
      characterId: artifact.characterId,
      characterVersion: 1,
      versionId: 'fixture-version',
    }
    const storage = createCharacterArtifactStorage(
      {
        send: async () => ({
          Body: body,
          ContentLength: artifact.byteLength,
          ContentType: artifact.mediaType,
          Metadata: { 'pathfinder-sha256': artifact.sha256 },
        }),
      },
      'fixture-bucket',
    )
    const pending = storage.getVerified({ tenantId: 'tenant-a', venueId: 'venue-a', reference })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('destroys an oversized streaming response at the byte boundary', async () => {
    const { artifact } = await fixture()
    const destroy = vi.fn()
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(12_000_001)
      },
    }
    const reference = {
      kind: 'character-bundle-v1' as const,
      bucket: 'fixture-bucket',
      objectKey: `character-factory/tenant-a/venue-a/${artifact.characterId}/v1/${artifact.sha256}.character.json`,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      mediaType: artifact.mediaType,
      characterId: artifact.characterId,
      characterVersion: 1,
      versionId: 'fixture-version',
    }
    const storage = createCharacterArtifactStorage(
      {
        send: async () => ({
          Body: body,
          ContentLength: artifact.byteLength,
          ContentType: artifact.mediaType,
          Metadata: { 'pathfinder-sha256': artifact.sha256 },
        }),
      },
      'fixture-bucket',
    )
    await expect(
      storage.getVerified({ tenantId: 'tenant-a', venueId: 'venue-a', reference }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(destroy).toHaveBeenCalledOnce()
  })
})
