import { describe, expect, it } from 'vitest'

import { VenuePackagePayloadV1 } from './venue-package'
import {
  canonicalDeploymentManifest,
  canonicalDeploymentManifestHashInput,
  deploymentManifestHash,
  diffDeploymentManifests,
  sha256Hex,
  VenueDeploymentFullManifest,
  VenueDeploymentManifest,
  VenueDeploymentPatchManifest,
  type VenueDeploymentFullManifest as FullManifest,
} from './venue-deployment-manifest'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const manifestId = '00000000-0000-4000-8000-000000000001'
const idempotencyKey = '00000000-0000-4000-8000-000000000002'

function full(): FullManifest {
  return VenueDeploymentFullManifest.parse({
    schemaVersion: 2,
    packageType: 'FULL',
    manifestId,
    venueRef: 'venue_science',
    idempotencyKey,
    identity: {
      venueStableId: 'venue_science',
      name: 'Science Museum',
      slug: 'science-museum',
      description: 'A museum for curious visitors.',
      archetype: 'museum',
    },
    branding: {
      themeId: 'forest',
      accentColor: '#245A4A',
      fontId: 'inter',
      logoAssetId: 'asset_logo',
    },
    aiConfiguration: {
      guideName: 'Scout',
      tone: { preset: 'friendly', behaviorVersion: 1 },
      modelReferences: [
        { purpose: 'CHAT', provider: 'openai', modelRef: 'gpt-5-mini', configVersion: 1 },
      ],
    },
    capabilities: {
      preset: 'museum',
      enabled: ['knowledge', 'places'],
      effectiveConfigurationProvenance: [
        {
          key: 'capability.knowledge',
          sourceLayer: 'preset-default',
          sourceId: 'museum',
        },
      ],
    },
    contentModules: [
      {
        id: 'knowledge_hours',
        kind: 'KNOWLEDGE',
        version: 1,
        audience: 'PUBLIC',
        title: 'Hours',
        body: 'Open daily from 9am to 5pm.',
        topics: ['hours', 'visit'],
        evidence: [
          {
            evidenceId: 'evidence_hours',
            sourceId: 'source_website',
            locator: 'https://example.org/hours',
            capturedAt: '2026-08-11T20:00:00.000Z',
            excerptHash: HASH_B,
          },
        ],
        assetIds: [],
      },
      {
        id: 'place_lobby',
        kind: 'PLACE',
        version: 1,
        audience: 'PUBLIC',
        name: 'Lobby',
        description: 'Main visitor entrance.',
        accessibility: ['Step-free entrance'],
        evidence: [],
        assetIds: ['asset_logo'],
      },
    ],
    assets: [
      {
        assetId: 'asset_logo',
        sha256: HASH_A,
        mediaType: 'image/png',
        byteSize: 1200,
        immutableRef: `asset:sha256/${HASH_A}`,
        filename: 'logo.png',
      },
    ],
    evaluation: {
      evaluationRunId: 'evaluation_1',
      readinessAssessmentId: 'readiness_1',
      readiness: 'READY_WITH_WARNINGS',
    },
    provenance: {
      sourceIds: ['source_website', 'source_interview'],
      evidenceIds: ['evidence_hours'],
      createdAt: '2026-08-11T20:00:00.000Z',
      createdBy: { kind: 'SYSTEM' },
      generatorRef: 'intake_engine_v1',
    },
  })
}

describe('Venue Deployment Manifest v2', () => {
  it('canonicalizes unordered collections and hashes them identically', () => {
    const first = full()
    const reordered = {
      ...first,
      contentModules: [...first.contentModules].reverse(),
      capabilities: {
        ...first.capabilities,
        enabled: [...first.capabilities.enabled].reverse(),
      },
      provenance: {
        ...first.provenance,
        sourceIds: [...first.provenance.sourceIds].reverse(),
      },
    }

    expect(VenueDeploymentManifest.safeParse(reordered).success).toBe(true)
    expect(canonicalDeploymentManifest(reordered)).toBe(canonicalDeploymentManifest(first))
    expect(deploymentManifestHash(reordered)).toBe(deploymentManifestHash(first))
    expect(deploymentManifestHash(first)).toMatch(/^[a-f0-9]{64}$/u)
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('diffs content through granular stable-ID upsert and retire operations', () => {
    const before = full()
    const desired = VenueDeploymentFullManifest.parse({
      ...before,
      manifestId: '00000000-0000-4000-8000-000000000003',
      contentModules: [
        {
          ...before.contentModules[0],
          version: 2,
          body: 'Open daily from 10am to 5pm.',
        },
      ],
    })

    const patch = diffDeploymentManifests(before, desired, {
      manifestId: '00000000-0000-4000-8000-000000000004',
      idempotencyKey: '00000000-0000-4000-8000-000000000005',
    })

    expect(patch.baseManifestHash).toBe(deploymentManifestHash(before))
    expect(patch.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'UPSERT_CONTENT_MODULE',
          value: expect.objectContaining({ id: 'knowledge_hours', version: 2 }),
        }),
        expect.objectContaining({
          op: 'RETIRE_CONTENT_MODULE',
          moduleKind: 'PLACE',
          moduleId: 'place_lobby',
          expectedVersion: 1,
        }),
      ]),
    )
    expect(patch).not.toHaveProperty('contentModules')
    expect(patch.operations.every((operation) => 'operationId' in operation)).toBe(true)
  })

  it('accepts explicit typed reset and retire operations without a replacement blob', () => {
    const patch = VenueDeploymentPatchManifest.parse({
      schemaVersion: 2,
      packageType: 'PATCH',
      manifestId,
      venueRef: 'venue_science',
      idempotencyKey,
      baseManifestHash: HASH_A,
      provenance: full().provenance,
      operations: [
        {
          operationId: '00000000-0000-4000-8000-000000000011',
          op: 'RESET_CONTENT_FIELD',
          moduleKind: 'PLACE',
          moduleId: 'place_lobby',
          field: 'description',
        },
        {
          operationId: '00000000-0000-4000-8000-000000000012',
          op: 'RETIRE_ASSET',
          assetId: 'asset_logo',
        },
        {
          operationId: '00000000-0000-4000-8000-000000000013',
          op: 'RESET_CONFIGURATION',
          path: 'aiConfiguration.tone',
        },
      ],
    })

    expect(patch.operations.map((operation) => operation.op)).toEqual([
      'RESET_CONTENT_FIELD',
      'RETIRE_ASSET',
      'RESET_CONFIGURATION',
    ])
  })

  it('prohibits tenant authority fields at the envelope and content levels', () => {
    expect(
      VenueDeploymentFullManifest.safeParse({ ...full(), tenantId: 'tenant_attacker' }).success,
    ).toBe(false)
    const withNestedTenant = full()
    expect(
      VenueDeploymentFullManifest.safeParse({
        ...withNestedTenant,
        contentModules: [{ ...withNestedTenant.contentModules[0], tenantId: 'tenant_attacker' }],
      }).success,
    ).toBe(false)
  })

  it('rejects unsafe asset URLs, raw binary fields, and secret-like AI fields', () => {
    const base = full()
    expect(
      VenueDeploymentFullManifest.safeParse({
        ...base,
        assets: [
          {
            ...base.assets[0],
            immutableRef: 'https://cdn.example.org/logo.png',
            data: 'iVBORw0KGgo=',
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      VenueDeploymentFullManifest.safeParse({
        ...base,
        aiConfiguration: { ...base.aiConfiguration, apiKey: 'secret-value' },
      }).success,
    ).toBe(false)
  })

  it('keeps complete canonical bytes while excluding the self-referential evaluation hash from the hash domain', () => {
    const value = full()
    const withEvaluatedHash = VenueDeploymentFullManifest.parse({
      ...value,
      evaluation: { ...value.evaluation, evaluatedManifestHash: HASH_C },
    })
    expect(canonicalDeploymentManifest(withEvaluatedHash)).toContain(HASH_C)
    expect(canonicalDeploymentManifestHashInput(withEvaluatedHash)).not.toContain(HASH_C)
    expect(deploymentManifestHash(withEvaluatedHash)).toBe(deploymentManifestHash(value))
  })

  it('rejects signed, credentialed and secret-like evidence locators', () => {
    const value = full()
    const module = value.contentModules[0]!
    for (const locator of [
      'https://example.org/source?token=secret',
      'https://user:password@example.org/source',
      'https://example.org/source#secret',
      'javascript:alert(1)',
    ]) {
      expect(
        VenueDeploymentFullManifest.safeParse({
          ...value,
          contentModules: [
            {
              ...module,
              evidence: [
                {
                  evidenceId: 'evidence_1',
                  sourceId: 'source_1',
                  locator,
                  capturedAt: '2026-08-12T12:00:00.000Z',
                },
              ],
            },
            ...value.contentModules.slice(1),
          ],
        }).success,
      ).toBe(false)
    }
  })

  it('does not alter the frozen legacy VenuePackage v1 contract', () => {
    expect(
      VenuePackagePayloadV1.safeParse({
        schemaVersion: 1,
        places: [],
        knowledgeEntries: [
          { title: 'Hours', category: 'Visit', content: 'Open daily.', isEnabled: true },
        ],
      }).success,
    ).toBe(true)
    expect(
      VenuePackagePayloadV1.safeParse({
        schemaVersion: 2,
        places: [],
        knowledgeEntries: [],
      }).success,
    ).toBe(false)
  })
})
