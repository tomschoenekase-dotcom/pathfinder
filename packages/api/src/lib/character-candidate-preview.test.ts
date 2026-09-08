import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createCharacterBundle,
  FACTORY_STATES,
  type CharacterSpec,
} from '@pathfinder/character-factory'

import { createCharacterArtifactStorage } from './character-artifact-storage'
import {
  CharacterCandidatePreviewError,
  readCharacterCandidateMasterPreview,
} from './character-candidate-preview'

const masterBytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>',
)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const spec: CharacterSpec = {
  schemaVersion: 1,
  characterId: 'preview-fixture',
  version: 1,
  revision: 1,
  displayName: 'Preview fixture',
  rigFamily: 'compact-creature-v1',
  source: {
    kind: 'imported',
    sourceUrl: 'https://example.test/source.svg',
    sourceRevision: 'fixture',
    license: 'CC0',
    attribution: 'Fixture',
    importedAt: '2026-09-08T00:00:00.000Z',
    sha256: sha256(masterBytes),
    mediaType: 'image/svg+xml',
    byteLength: masterBytes.byteLength,
  },
  masterReference: 'source/master.svg',
  protectedTraits: ['round eyes'],
  slotMap: { body: 'body' },
  supportedStates: FACTORY_STATES,
  status: 'exported',
}

async function fixture() {
  const artifact = await createCharacterBundle(spec, [
    { path: spec.masterReference, mediaType: 'image/svg+xml', bytes: masterBytes, role: 'master' },
    {
      path: 'slots/body.svg',
      mediaType: 'image/svg+xml',
      bytes: masterBytes,
      role: 'slot',
      slot: 'body',
    },
    {
      path: 'fallback/master.svg',
      mediaType: 'image/svg+xml',
      bytes: masterBytes,
      role: 'fallback',
    },
  ])
  const reference = {
    kind: 'character-bundle-v1' as const,
    bucket: 'fixture-bucket',
    objectKey: `character-factory/tenant-a/venue-a/${artifact.characterId}/v${artifact.characterVersion}/${artifact.sha256}.character.json`,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    mediaType: artifact.mediaType,
    characterId: artifact.characterId,
    characterVersion: artifact.characterVersion,
    versionId: 'fixture-version',
  }
  const reader = createCharacterArtifactStorage(
    {
      send: async () => ({
        Body: (async function* () {
          yield artifact.bytes
        })(),
        ContentLength: artifact.byteLength,
        ContentType: artifact.mediaType,
        Metadata: { 'pathfinder-sha256': artifact.sha256 },
      }),
    },
    'fixture-bucket',
  )
  return { artifact, reference, reader }
}

describe('character candidate preview', () => {
  it('extracts only the exact verified imported master bytes', async () => {
    const { reference, reader } = await fixture()
    await expect(
      readCharacterCandidateMasterPreview({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        artifactReference: reference,
        expectedSpec: spec,
        reader,
      }),
    ).resolves.toEqual({
      mediaType: 'image/svg+xml',
      bytesBase64: globalThis.btoa(String.fromCharCode(...masterBytes)),
      sha256: spec.source.sha256,
    })
  })

  it('fails closed before storage reads for a different tenant scope or expected version', async () => {
    const { reference, reader } = await fixture()
    await expect(
      readCharacterCandidateMasterPreview({
        tenantId: 'tenant-b',
        venueId: 'venue-a',
        artifactReference: reference,
        expectedSpec: spec,
        reader,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    await expect(
      readCharacterCandidateMasterPreview({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        artifactReference: reference,
        expectedSpec: { ...spec, version: 2 },
        reader,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  })

  it('fails closed when a verified-reader result lacks the master or changes source provenance', async () => {
    const { reference } = await fixture()
    const missingMaster = {
      reference,
      spec,
      bytes: new TextEncoder().encode(JSON.stringify({ assets: [] })),
    }
    await expect(
      readCharacterCandidateMasterPreview({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        artifactReference: reference,
        expectedSpec: spec,
        reader: { getVerified: async () => missingMaster },
      }),
    ).rejects.toBeInstanceOf(CharacterCandidatePreviewError)
    const badMaster = {
      reference,
      spec,
      bytes: new TextEncoder().encode(
        JSON.stringify({
          assets: [
            {
              path: spec.masterReference,
              role: 'master',
              mediaType: 'image/svg+xml',
              sha256: '0'.repeat(64),
              bytesBase64: 'eA==',
            },
          ],
        }),
      ),
    }
    await expect(
      readCharacterCandidateMasterPreview({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        artifactReference: reference,
        expectedSpec: spec,
        reader: { getVerified: async () => badMaster },
      }),
    ).rejects.toBeInstanceOf(CharacterCandidatePreviewError)
  })
})
