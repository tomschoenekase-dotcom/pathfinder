import { createHash, randomUUID } from 'node:crypto'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  createCharacterBundle,
  FACTORY_STATES,
  type CharacterSpec,
} from '@pathfinder/character-factory'
import {
  claimCharacterFactoryJobAction,
  completeCharacterFactoryJobAction,
  db,
  prepareCharacterFactoryJobAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createCharacterArtifactStorage,
  type CharacterArtifactTransport,
} from './character-artifact-storage'

const integrationDescribe =
  process.env.RUN_CHARACTER_ARTIFACT_STORAGE_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('character artifact storage (disposable MinIO)', () => {
  const endpoint = process.env.STORAGE_ENDPOINT ?? ''
  const bucket = process.env.STORAGE_BUCKET ?? ''
  const region = process.env.STORAGE_REGION ?? ''
  let client: S3Client
  let unversionedClient: S3Client
  let unversionedBucket = ''
  let key = ''
  let unversionedKey = ''

  beforeAll(async () => {
    const url = new URL(endpoint)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Character artifact integration requires an exact loopback HTTP endpoint and port.',
      )
    if (!/^pathfinder-disposable-(?:character|intake)-[a-z0-9-]+$/.test(bucket))
      throw new Error('Character artifact integration requires a disposable bucket.')
    const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID ?? ''
    const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY ?? ''
    if (!region || !accessKeyId || !secretAccessKey)
      throw new Error('Character artifact integration requires synthetic local credentials.')
    client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    })
    unversionedClient = client
    unversionedBucket = `${bucket}-plain`
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    await client.send(new CreateBucketCommand({ Bucket: unversionedBucket }))
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    )
  })

  afterAll(async () => {
    if (!client) return
    const listed = await client
      .send(new ListObjectVersionsCommand({ Bucket: bucket }))
      .catch(() => null)
    const objects = [...(listed?.Versions ?? []), ...(listed?.DeleteMarkers ?? [])].flatMap(
      (value) =>
        value.Key && value.VersionId ? [{ Key: value.Key, VersionId: value.VersionId }] : [],
    )
    if (objects.length)
      await client
        .send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }))
        .catch(() => undefined)
    await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined)
    if (unversionedKey)
      await client
        .send(new DeleteObjectCommand({ Bucket: unversionedBucket, Key: unversionedKey }))
        .catch(() => undefined)
    await client.send(new DeleteBucketCommand({ Bucket: unversionedBucket })).catch(() => undefined)
    client.destroy()
    await db.$disconnect()
  })

  it('roundtrips exact bundle bytes and detects tamper, missing, and tenant crossing', async () => {
    const source = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="2" cy="2" r="2"/></svg>',
    )
    const spec: CharacterSpec = {
      schemaVersion: 1,
      characterId: 'lion-fixture',
      version: 2,
      revision: 2,
      displayName: 'Lion fixture',
      rigFamily: 'custom:quadruped-lion-v1',
      rigCapabilities: {
        schemaVersion: 1,
        familyId: 'custom:quadruped-lion-v1',
        anatomyClass: 'creature',
        requiredSlots: ['body'],
        stateControls: { speaking: ['jaw'] },
      },
      source: {
        kind: 'imported',
        sourceUrl: 'https://example.test/lion.svg',
        sourceRevision: 'fixture-1',
        license: 'CC0',
        attribution: 'Fixture',
        importedAt: '2026-09-07T00:00:00.000Z',
        sha256: createHash('sha256').update(source).digest('hex'),
        mediaType: 'image/svg+xml',
        byteLength: source.byteLength,
      },
      masterReference: 'source/lion.svg',
      protectedTraits: ['mane'],
      slotMap: { body: 'body' },
      supportedStates: FACTORY_STATES,
      status: 'exported',
    }
    const artifact = await createCharacterBundle(spec, [
      { path: 'source/lion.svg', mediaType: 'image/svg+xml', bytes: source, role: 'master' },
      {
        path: 'slots/body.svg',
        mediaType: 'image/svg+xml',
        bytes: source,
        role: 'slot',
        slot: 'body',
      },
      { path: 'fallback/lion.svg', mediaType: 'image/svg+xml', bytes: source, role: 'fallback' },
    ])
    const storage = createCharacterArtifactStorage(
      client as unknown as CharacterArtifactTransport,
      bucket,
    )
    const reference = await storage.put({ tenantId: 'tenant-a', venueId: 'venue-a', artifact })
    if (reference.kind !== 'character-bundle-v1')
      throw new Error('Expected versioned fixture bucket.')
    key = reference.objectKey
    await expect(
      storage.put({ tenantId: 'tenant-a', venueId: 'venue-a', artifact }),
    ).resolves.toEqual(reference)
    await expect(
      storage.getVerified({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        reference,
        expectedSpec: spec,
      }),
    ).resolves.toMatchObject({ spec })
    await expect(
      storage.getVerified({ tenantId: 'tenant-b', venueId: 'venue-a', reference }),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    const tampered = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: new TextEncoder().encode('tampered'),
      }),
    )
    await expect(
      storage.getVerified({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        reference: { ...reference, versionId: tampered.VersionId! },
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: reference.versionId }),
    )
    await expect(
      storage.getVerified({ tenantId: 'tenant-a', venueId: 'venue-a', reference }),
    ).rejects.toMatchObject({ code: 'MISSING' })
    expect(storage.cleanupCancelled(reference)).toEqual({
      disposition: 'retained-content-addressed',
    })
  })

  it('persists only the version-pinned bundle that exactly matches the completed job spec', async () => {
    if (!/\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? ''))
      throw new Error(
        'Combined character artifact proof requires a disposable PostgreSQL database.',
      )
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-artifact-${suffix}`
      const venueId = `venue-artifact-${suffix}`
      const characterId = `character-artifact-${suffix}`
      const requestId = `create-artifact-${suffix}`
      await db.tenant.create({
        data: { id: tenantId, name: 'Disposable artifact tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Disposable artifact venue', slug: venueId },
      })
      const source = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h3v3z"/></svg>',
      )
      const sha256 = createHash('sha256').update(source).digest('hex')
      const spec: CharacterSpec = {
        schemaVersion: 1,
        characterId,
        version: 1,
        revision: 1,
        displayName: 'Candidate talking object',
        rigFamily: 'custom:talking-object-v1',
        rigCapabilities: {
          schemaVersion: 1,
          familyId: 'custom:talking-object-v1',
          anatomyClass: 'object',
          requiredSlots: ['body'],
          stateControls: { speaking: ['mouth'] },
        },
        source: {
          kind: 'imported',
          sourceUrl: 'https://example.test/object.svg',
          sourceRevision: 'fixture-1',
          license: 'CC0',
          attribution: 'Fixture',
          importedAt: '2026-09-07T00:00:00.000Z',
          sha256,
          mediaType: 'image/svg+xml',
          byteLength: source.byteLength,
        },
        masterReference: 'source/object.svg',
        protectedTraits: ['screen'],
        slotMap: { body: 'body' },
        supportedStates: FACTORY_STATES,
        status: 'candidate',
      }
      const artifact = await createCharacterBundle(spec, [
        { path: 'source/object.svg', mediaType: 'image/svg+xml', bytes: source, role: 'master' },
        {
          path: 'slots/body.svg',
          mediaType: 'image/svg+xml',
          bytes: source,
          role: 'slot',
          slot: 'body',
        },
        {
          path: 'fallback/object.svg',
          mediaType: 'image/svg+xml',
          bytes: source,
          role: 'fallback',
        },
      ])
      const storage = createCharacterArtifactStorage(
        unversionedClient as unknown as CharacterArtifactTransport,
        unversionedBucket,
      )
      const reference = await storage.put({ tenantId, venueId, artifact })
      unversionedKey = reference.objectKey
      expect(reference.kind).toBe('character-bundle-content-v1')
      expect(reference).not.toHaveProperty('versionId')
      await prepareCharacterFactoryJobAction({
        tenantId,
        venueId,
        requestId,
        action: 'CREATE_FROM_IMPORT',
        requestPayload: {
          characterId,
          sourceAssetReference: spec.masterReference,
          sourceSha256: sha256,
        },
        actor: { id: 'artifact-integration', role: 'PLATFORM_ADMIN' },
      })
      const claimed = await claimCharacterFactoryJobAction({ tenantId, venueId, requestId })
      if (claimed.state !== 'claimed') throw new Error('Expected combined artifact job claim.')
      await completeCharacterFactoryJobAction(
        {
          tenantId,
          venueId,
          requestId,
          leaseToken: claimed.job.leaseToken!,
          resultPayload: { stored: true },
          characterSpec: spec,
          assetStorageReference: reference,
          actor: { id: 'artifact-integration', role: 'PLATFORM_ADMIN' },
        },
        undefined,
        {
          verifyArtifact: async ({ expectedSpec }) => {
            const verified = await storage.getVerified({
              tenantId,
              venueId,
              reference,
              expectedSpec,
            })
            return { reference: verified.reference, spec: verified.spec }
          },
        },
      )
      const saved = await db.customCharacter.findFirstOrThrow({
        where: { id: characterId, tenantId, venueId },
      })
      expect(saved.assetStorageReference).toEqual(reference)
      await expect(
        storage.getVerified({ tenantId, venueId, reference, expectedSpec: spec }),
      ).resolves.toMatchObject({ spec })
    })
  })
})
