import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { FACTORY_STATES, type CharacterSpec } from '@pathfinder/character-factory'

import { db, withTenantIsolationBypass } from '../index'
import {
  cancelCharacterFactoryJobAction,
  claimCharacterFactoryJobAction,
  completeCharacterFactoryJobAction,
  heartbeatCharacterFactoryJobAction,
  failCharacterFactoryJobAction,
  prepareCharacterFactoryJobAction,
} from './custom-character-factory-actions'

const enabled =
  process.env.RUN_CHARACTER_FACTORY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('character factory durable disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it(
    'proves replay, cross-worker lease fencing, cancellation, completion, and revision fencing',
    async () =>
      withTenantIsolationBypass(async () => {
        const suffix = randomUUID().slice(0, 8)
        const tenantId = `tenant-character-${suffix}`
        const venueId = `venue-character-${suffix}`
        const actor = { id: 'character-factory-integration', role: 'PLATFORM_ADMIN' as const }
        await db.tenant.create({
          data: { id: tenantId, name: 'Disposable character tenant', slug: tenantId },
        })
        await db.venue.create({
          data: { id: venueId, tenantId, name: 'Disposable character venue', slug: venueId },
        })
        {
          const createRequestId = `create-${suffix}`
          const prepared = await prepareCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: createRequestId,
            action: 'CREATE_FROM_IMPORT',
            requestPayload: {
              characterId: `character-${suffix}`,
              sourceAssetReference: 'source/owl.svg',
              sourceSha256: '0'.repeat(64),
            },
            actor,
          })
          expect(prepared.job).not.toHaveProperty('leaseToken')
          expect(
            (
              await prepareCharacterFactoryJobAction({
                tenantId,
                venueId,
                requestId: createRequestId,
                action: 'CREATE_FROM_IMPORT',
                requestPayload: {
                  characterId: `character-${suffix}`,
                  sourceAssetReference: 'source/owl.svg',
                  sourceSha256: '0'.repeat(64),
                },
                actor,
              })
            ).replayed,
          ).toBe(true)
          await expect(
            prepareCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: createRequestId,
              action: 'CREATE_FROM_IMPORT',
              requestPayload: {
                characterId: `character-${suffix}`,
                sourceAssetReference: 'source/astronaut.svg',
                sourceSha256: '1'.repeat(64),
              },
              actor,
            }),
          ).rejects.toMatchObject({ code: 'CONFLICT' })

          const [first, second] = await Promise.all([
            claimCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: createRequestId,
            }),
            claimCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: createRequestId,
            }),
          ])
          expect([first.state, second.state].sort()).toEqual(['claimed', 'not-claimed'])
          const winner = first.state === 'claimed' ? first : second
          if (winner.state !== 'claimed') throw new Error('Expected one durable claim winner')
          const winningLease = winner.job.leaseToken!
          const characterId = `character-${suffix}`
          const spec: CharacterSpec = {
            schemaVersion: 1,
            characterId,
            version: 1,
            revision: 1,
            displayName: 'Disposable Owl',
            rigFamily: 'compact-creature-v1',
            source: {
              kind: 'imported',
              sourceUrl: 'https://openmoji.org/library/emoji-1F989/',
              sourceRevision: 'fixture',
              license: 'CC-BY-SA-4.0',
              attribution: 'OpenMoji contributors',
              importedAt: new Date().toISOString(),
              sha256: '0'.repeat(64),
              mediaType: 'image/svg+xml',
              byteLength: 1,
            },
            masterReference: 'source/owl.svg',
            protectedTraits: ['round eyes'],
            slotMap: { body: 'body' },
            supportedStates: FACTORY_STATES,
            status: 'candidate',
          }
          await expect(
            completeCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: createRequestId,
              leaseToken: winningLease,
              resultPayload: { compatible: true },
              actor,
            }),
          ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
          await expect(
            completeCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: createRequestId,
              leaseToken: winningLease,
              resultPayload: { compatible: true },
              actor,
              characterSpec: spec,
              assetStorageReference: { assertedOnly: true },
            }),
          ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
          await expect(
            completeCharacterFactoryJobAction(
              {
                tenantId,
                venueId,
                requestId: createRequestId,
                leaseToken: winningLease,
                resultPayload: { compatible: true },
                actor,
                characterSpec: spec,
                assetStorageReference: { fixture: 'wrong-spec' },
              },
              undefined,
              {
                verifyArtifact: async () => ({
                  reference: { kind: 'character-bundle-v1' },
                  spec: { ...spec, displayName: 'Mutated after rendering' },
                }),
              },
            ),
          ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
          const validCreateReference = {
            kind: 'character-bundle-v1',
            bucket: 'fixture-bucket',
            objectKey: 'fixture/bundle',
            sha256: '0'.repeat(64),
            byteLength: 100,
            mediaType: 'application/vnd.pathfinder.character+json',
            characterId,
            characterVersion: 1,
            versionId: 'fixture-version',
          }
          const missingRequiredField = Object.fromEntries(
            Object.entries(validCreateReference).filter(([key]) => key !== 'versionId'),
          )
          const malformedReferences: unknown[] = [
            missingRequiredField,
            { ...validCreateReference, mediaType: 'application/json' },
            { ...validCreateReference, sha256: 'not-a-sha256' },
            { ...validCreateReference, byteLength: Number.NaN },
            { ...validCreateReference, byteLength: -1 },
            { ...validCreateReference, byteLength: 12_000_001 },
            { ...validCreateReference, unexpected: true },
          ]
          for (const malformedReference of malformedReferences) {
            await expect(
              completeCharacterFactoryJobAction(
                {
                  tenantId,
                  venueId,
                  requestId: createRequestId,
                  leaseToken: winningLease,
                  resultPayload: { compatible: true },
                  actor,
                  characterSpec: spec,
                  assetStorageReference: { fixture: 'malformed-reference-matrix' },
                },
                undefined,
                {
                  verifyArtifact: async ({ expectedSpec }) => ({
                    reference: malformedReference as Record<string, string | number>,
                    spec: expectedSpec,
                  }),
                },
              ),
            ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
            await expect(
              db.characterFactoryJob.findUniqueOrThrow({
                where: { id: prepared.job.id },
                select: { status: true, resultPayload: true },
              }),
            ).resolves.toEqual({ status: 'RUNNING', resultPayload: null })
            expect(await db.customCharacter.count({ where: { id: characterId } })).toBe(0)
          }
          await expect(
            completeCharacterFactoryJobAction(
              {
                tenantId,
                venueId,
                requestId: createRequestId,
                leaseToken: winningLease,
                resultPayload: { compatible: true },
                actor,
                characterSpec: spec,
                assetStorageReference: { fixture: 'malformed-reference' },
              },
              undefined,
              {
                verifyArtifact: async ({ expectedSpec }) => ({
                  reference: {
                    kind: 'character-bundle-v1',
                    bucket: 'fixture-bucket',
                    objectKey: 'fixture/bundle',
                    sha256: '0'.repeat(64),
                    byteLength: 100,
                    mediaType: 'application/vnd.pathfinder.character+json',
                    characterId: expectedSpec.characterId,
                    characterVersion: expectedSpec.version + 1,
                    versionId: 'fixture-version',
                  },
                  spec: expectedSpec,
                }),
              },
            ),
          ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
          await expect(
            db.characterFactoryJob.findUniqueOrThrow({
              where: { id: prepared.job.id },
              select: { status: true, resultPayload: true },
            }),
          ).resolves.toEqual({ status: 'RUNNING', resultPayload: null })
          expect(await db.customCharacter.count({ where: { id: characterId } })).toBe(0)
          await completeCharacterFactoryJobAction(
            {
              tenantId,
              venueId,
              requestId: createRequestId,
              leaseToken: winningLease,
              resultPayload: { compatible: true },
              actor,
              characterSpec: spec,
              assetStorageReference: { fixture: 'bundle' },
            },
            undefined,
            {
              verifyArtifact: async ({ expectedSpec }) => ({
                reference: {
                  kind: 'character-bundle-v1',
                  bucket: 'fixture-bucket',
                  objectKey: 'fixture/bundle',
                  sha256: '0'.repeat(64),
                  byteLength: 100,
                  mediaType: 'application/vnd.pathfinder.character+json',
                  characterId: expectedSpec.characterId,
                  characterVersion: expectedSpec.version,
                  versionId: 'fixture-version',
                },
                spec: expectedSpec,
              }),
            },
          )
          expect(
            (await db.characterFactoryJob.findUniqueOrThrow({ where: { id: prepared.job.id } }))
              .status,
          ).toBe('SUCCEEDED')

          const exportRequestId = `export-${suffix}`
          await prepareCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: exportRequestId,
            action: 'EXPORT',
            requestPayload: { includeEditableSource: true },
            characterId,
            baseVersion: 1,
            baseRevision: 1,
            actor,
          })
          const exportClaim = await claimCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: exportRequestId,
          })
          if (exportClaim.state !== 'claimed') throw new Error('Expected export claim')
          const exportedSpec: CharacterSpec = { ...spec, revision: 2, status: 'exported' }
          const exportReference = {
            kind: 'character-bundle-v1' as const,
            bucket: 'fixture-bucket',
            objectKey: 'fixture/exported-bundle',
            sha256: '2'.repeat(64),
            byteLength: 144,
            mediaType: 'application/vnd.pathfinder.character+json' as const,
            characterId,
            characterVersion: 1,
            versionId: 'fixture-export-version',
          }
          await expect(
            completeCharacterFactoryJobAction(
              {
                tenantId,
                venueId,
                requestId: exportRequestId,
                leaseToken: exportClaim.job.leaseToken!,
                resultPayload: { exported: true },
                actor,
                characterSpec: exportedSpec,
                assetStorageReference: exportReference,
              },
              undefined,
              {
                verifyArtifact: async ({ expectedSpec }) => ({
                  reference: { ...exportReference, characterId: `wrong-${characterId}` },
                  spec: expectedSpec,
                }),
              },
            ),
          ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
          await completeCharacterFactoryJobAction(
            {
              tenantId,
              venueId,
              requestId: exportRequestId,
              leaseToken: exportClaim.job.leaseToken!,
              resultPayload: { exported: true },
              actor,
              characterSpec: exportedSpec,
              assetStorageReference: exportReference,
            },
            undefined,
            {
              verifyArtifact: async ({ expectedSpec }) => ({
                reference: exportReference,
                spec: expectedSpec,
              }),
            },
          )
          const exportedCharacter = await db.customCharacter.findUniqueOrThrow({
            where: { id: characterId },
            select: {
              version: true,
              revision: true,
              status: true,
              capabilityMetadata: true,
              assetStorageReference: true,
            },
          })
          expect(exportedCharacter).toMatchObject({
            version: 1,
            revision: 2,
            status: 'REVIEW',
            assetStorageReference: exportReference,
            capabilityMetadata: {
              characterFactory: {
                spec: {
                  status: 'exported',
                  source: {
                    kind: 'imported',
                    sha256: spec.source.sha256,
                    sourceUrl: spec.source.sourceUrl,
                    license: spec.source.license,
                    attribution: spec.source.attribution,
                  },
                },
              },
            },
          })

          const cancelRequestId = `cancel-${suffix}`
          await prepareCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: cancelRequestId,
            action: 'REVISE',
            requestPayload: {
              instructions: 'Keep the round eyes.',
              protectedTraits: ['round eyes'],
            },
            characterId,
            baseVersion: 1,
            baseRevision: 2,
            actor,
          })
          const cancelClaim = await claimCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: cancelRequestId,
          })
          if (cancelClaim.state !== 'claimed') throw new Error('Expected cancellation claim')
          await cancelCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: cancelRequestId,
            actor,
          })
          await expect(
            heartbeatCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: cancelRequestId,
              leaseToken: cancelClaim.job.leaseToken!,
            }),
          ).rejects.toMatchObject({ code: 'CONFLICT' })

          const raceRequestId = `cancel-race-${suffix}`
          await prepareCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: raceRequestId,
            action: 'INSPECT',
            requestPayload: {},
            characterId,
            actor,
          })
          const raceClaim = await claimCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: raceRequestId,
          })
          if (raceClaim.state !== 'claimed') throw new Error('Expected cancellation race claim')
          await Promise.allSettled([
            cancelCharacterFactoryJobAction({ tenantId, venueId, requestId: raceRequestId, actor }),
            completeCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: raceRequestId,
              leaseToken: raceClaim.job.leaseToken!,
              resultPayload: { inspected: true },
              actor,
            }),
          ])
          const terminalRace = await db.characterFactoryJob.findFirstOrThrow({
            where: { tenantId, requestId: raceRequestId },
          })
          expect(['CANCELLED', 'SUCCEEDED']).toContain(terminalRace.status)
          expect(terminalRace.leaseToken).toBeNull()

          const expiryRequestId = `expiry-${suffix}`
          await prepareCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: expiryRequestId,
            action: 'INSPECT',
            requestPayload: {},
            characterId,
            actor,
          })
          const claimedAt = new Date('2030-01-01T00:00:00.000Z')
          const expiryClaim = await claimCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: expiryRequestId,
            now: claimedAt,
          })
          if (expiryClaim.state !== 'claimed') throw new Error('Expected expiry claim')
          await expect(
            failCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: expiryRequestId,
              leaseToken: expiryClaim.job.leaseToken!,
              errorCode: 'LATE',
              errorMessage: 'late worker',
              actor,
              now: new Date(claimedAt.getTime() + 60_001),
            }),
          ).rejects.toMatchObject({ code: 'CONFLICT' })

          await expect(
            prepareCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: `invalid-${suffix}`,
              action: 'REVISE',
              requestPayload: { instructions: 'x', unexpected: true },
              characterId,
              actor,
            }),
          ).rejects.toBeDefined()

          const staleRequestId = `stale-${suffix}`
          await prepareCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: staleRequestId,
            action: 'REVISE',
            requestPayload: { instructions: 'Refine expression.' },
            characterId,
            baseVersion: 1,
            baseRevision: 2,
            actor,
          })
          const staleClaim = await claimCharacterFactoryJobAction({
            tenantId,
            venueId,
            requestId: staleRequestId,
          })
          if (staleClaim.state !== 'claimed') throw new Error('Expected stale revision claim')
          await db.customCharacter.update({ where: { id: characterId }, data: { revision: 3 } })
          await expect(
            completeCharacterFactoryJobAction({
              tenantId,
              venueId,
              requestId: staleRequestId,
              leaseToken: staleClaim.job.leaseToken!,
              resultPayload: {},
              actor,
              characterSpec: { ...spec, version: 2, revision: 3 },
            }),
          ).rejects.toMatchObject({ code: 'CONFLICT' })
        }
      }),
    30_000,
  )
})
