import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { Prisma } from '@prisma/client'
import { nativeGuestReadTenantFlagKey } from '@pathfinder/config/feature-flags'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import {
  createCharacterArtifactStorage,
  type CharacterArtifactTransport,
} from './character-artifact-storage'
import {
  readPublishedCustomCharacterAsset,
  resolvePublishedCustomCharacterProjection,
  verifyNativeCustomCharacterPublication,
  type CustomCharacterPublicationDependencies,
} from './custom-character-publication'
import {
  createCharacterBundle,
  FACTORY_STATES,
  readCharacterRuntimeAsset,
  readCharacterRuntimePack,
  type CharacterRuntimePack,
  type CharacterSpec,
} from '@pathfinder/character-factory'
import { canonicalCharacterRuntimePack } from '@pathfinder/contracts/character-runtime-pack'
import {
  approveNativeVenueDeploymentAction,
  applyNativeVenueDeploymentAction,
  claimCharacterFactoryJobAction,
  completeCharacterFactoryJobAction,
  createNativeVenueDeploymentAction,
  db,
  createOrReplayEvaluationRun,
  markEvaluationRunQueued,
  claimEvaluationRunAttempt,
  finishEvaluationRunAttempt,
  recordNativeDeploymentEvaluationEvidenceAction,
  type CustomCharacterPublicationEvidence,
  decideCharacterCandidateReview,
  prepareCharacterFactoryJobAction,
  projectNativeVenueStateAction,
  readCustomCharacterPublicationEvidence,
  revertNativeVenueDeploymentAction,
  submitCharacterCandidateReviewBrief,
  withTenantIsolationBypass,
} from '@pathfinder/db'

const enabled =
  process.env.RUN_CHARACTER_PUBLICATION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_character_factory_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

const neutralSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#6b7280"/></svg>'
const neutralBytes = new TextEncoder().encode(neutralSvg)
const neutralSha256 = createHash('sha256').update(neutralBytes).digest('hex')
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

describe.skipIf(!enabled)('custom character publication disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it(
    'binds a server-verified ACCEPT export to native apply/revert without following a later draft',
    async () =>
      withTenantIsolationBypass(async () => {
        const suffix = randomUUID().slice(0, 12)
        const tenantId = `tenant-character-publication-${suffix}`
        const venueId = `venue-character-publication-${suffix}`
        const otherVenueId = `venue-character-publication-other-${suffix}`
        const characterId = `character-publication-${suffix}`
        const importedAt = '2026-09-11T00:00:00.000Z'
        const agent = { id: `agent-${suffix}`, role: 'AGENT' as const, type: 'AGENT' as const }
        const human = {
          id: `human-${suffix}`,
          role: 'PLATFORM_ADMIN' as const,
          type: 'HUMAN' as const,
        }
        await db.tenant.create({
          data: { id: tenantId, name: 'Disposable character publication tenant', slug: tenantId },
        })
        await db.venue.createMany({
          data: [venueId, otherVenueId].map((id) => ({
            id,
            tenantId,
            name: id,
            slug: id,
          })),
        })

        const spec = (
          version: number,
          revision: number,
          status: 'candidate' | 'exported',
        ): CharacterSpec => ({
          schemaVersion: 1,
          characterId,
          version,
          revision,
          displayName: 'Neutral prepared fixture',
          rigFamily: 'compact-creature-v1',
          source: {
            kind: 'imported',
            sourceUrl: 'https://example.invalid/neutral-prepared-fixture.svg',
            sourceRevision: 'fixture',
            license: 'CC-BY-SA-4.0',
            attribution: 'Disposable neutral prepared fixture only',
            importedAt,
            sha256: neutralSha256,
            mediaType: 'image/svg+xml',
            byteLength: neutralBytes.byteLength,
          },
          masterReference: 'source/neutral.svg',
          protectedTraits: ['fixture-only'],
          slotMap: { body: 'body' },
          supportedStates: FACTORY_STATES,
          status,
        })
        const runtimePack = (value: CharacterSpec): CharacterRuntimePack => ({
          schemaVersion: 1,
          renderer: 'family-rig-v1',
          characterId: value.characterId,
          characterVersion: value.version,
          sourceSha256: value.source.sha256,
          family: 'compact-creature-v1',
          capability: 'rigid-source',
          assets: [
            {
              id: 'source',
              path: value.masterReference,
              mediaType: 'image/svg+xml',
              width: 10,
              height: 10,
              bytes: neutralBytes.byteLength,
              sha256: neutralSha256,
            },
            {
              id: 'fallback',
              path: 'fallback/static.svg',
              mediaType: 'image/svg+xml',
              width: 10,
              height: 10,
              bytes: neutralBytes.byteLength,
              sha256: neutralSha256,
            },
            {
              id: 'body',
              path: 'slots/body.svg',
              mediaType: 'image/svg+xml',
              width: 10,
              height: 10,
              bytes: neutralBytes.byteLength,
              sha256: neutralSha256,
            },
          ],
          canvas: { width: 10, height: 10 },
          safeBounds: { x: 0, y: 0, width: 10, height: 10 },
          origin: { x: 5, y: 5 },
          anchors: { lookAt: { x: 5, y: 4 }, embers: { x: 5, y: 8 } },
          sourceAssetId: 'source',
          staticFallbackAssetId: 'fallback',
          reducedMotionFallbackAssetId: 'fallback',
          layers: [{ role: 'body', assetId: 'body' }],
          supportedStates: ['idle'],
          stateFallbacks: {
            attention: 'idle',
            listening: 'idle',
            thinking: 'idle',
            speaking: 'idle',
            success: 'idle',
            processing: 'idle',
            uploadReceiving: 'idle',
            uploadComplete: 'idle',
            question: 'idle',
            handoff: 'idle',
            error: 'idle',
            sleeping: 'idle',
            minimized: 'idle',
          },
          supportedContexts: ['client-assistant', 'venue-text-chat'],
        })
        const retained = new Map<string, Awaited<ReturnType<typeof createCharacterBundle>>>()
        const build = async (value: CharacterSpec, pack = runtimePack(value)) => {
          const bundle = await createCharacterBundle(
            value,
            [
              {
                path: value.masterReference,
                mediaType: 'image/svg+xml',
                role: 'master',
                bytes: neutralBytes,
              },
              {
                path: 'fallback/static.svg',
                mediaType: 'image/svg+xml',
                role: 'fallback',
                bytes: neutralBytes,
              },
              {
                path: 'slots/body.svg',
                mediaType: 'image/svg+xml',
                role: 'slot',
                slot: 'body',
                bytes: neutralBytes,
              },
            ],
            pack,
          )
          retained.set(`fixture-${bundle.sha256.slice(0, 16)}`, bundle)
          return bundle
        }
        const candidate = spec(1, 1, 'candidate')
        const candidateBundle = await build(candidate)
        const artifactReference = (bundle: Awaited<ReturnType<typeof build>>) => ({
          kind: 'character-bundle-v1' as const,
          bucket: 'fixture-bucket',
          objectKey: `character-factory/${tenantId}/${venueId}/${characterId}/v${bundle.characterVersion}/${bundle.sha256}.character.json`,
          sha256: bundle.sha256,
          byteLength: bundle.byteLength,
          mediaType: 'application/vnd.pathfinder.character+json' as const,
          characterId,
          characterVersion: bundle.characterVersion,
          versionId: `fixture-${bundle.sha256.slice(0, 16)}`,
        })
        const transfer = { reads: 0, bytes: 0 }
        const transport: CharacterArtifactTransport = {
          send: async (command) => {
            const version = 'VersionId' in command.input ? command.input.VersionId : undefined
            const bundle = retained.get(version ?? '')
            if (
              command.constructor.name !== 'GetObjectCommand' ||
              !bundle ||
              command.input.Bucket !== 'fixture-bucket' ||
              command.input.Key !== artifactReference(bundle).objectKey
            )
              throw new Error('Unknown immutable fixture object')
            transfer.reads++
            transfer.bytes += bundle.bytes.byteLength
            return {
              ContentLength: bundle.byteLength,
              ContentType: bundle.mediaType,
              Metadata: { 'pathfinder-sha256': bundle.sha256 },
              Body: (async function* () {
                yield bundle.bytes
              })(),
            }
          },
        }
        const storage = createCharacterArtifactStorage(transport, 'fixture-bucket')
        const dependencies: CustomCharacterPublicationDependencies = {
          client: db,
          storage,
          featureEnabled: () => true,
          rateLimit: async () => true,
          environment: {
            NATIVE_GUEST_CONTENT_READ_ENABLED: 'true',
            RAILWAY_ENVIRONMENT: 'staging',
          },
        }
        const verify = async (bundle: Awaited<ReturnType<typeof build>>) =>
          storage.getVerified({ tenantId, venueId, reference: artifactReference(bundle) })

        await prepareCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId: `import-${suffix}`,
          action: 'CREATE_FROM_IMPORT',
          requestPayload: {
            characterId,
            sourceAssetReference: candidate.masterReference,
            sourceSha256: neutralSha256,
          },
          actor: human,
        })
        const importClaim = await claimCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId: `import-${suffix}`,
        })
        if (importClaim.state !== 'claimed') throw new Error('Expected disposable import claim.')
        await completeCharacterFactoryJobAction(
          {
            tenantId,
            venueId,
            requestId: `import-${suffix}`,
            leaseToken: importClaim.job.leaseToken!,
            resultPayload: { fixture: 'neutral-prepared' },
            characterSpec: candidate,
            assetStorageReference: artifactReference(candidateBundle),
            actor: human,
          },
          undefined,
          { verifyArtifact: () => verify(candidateBundle) },
        )
        const brief = await submitCharacterCandidateReviewBrief({
          tenantId,
          venueId,
          characterId,
          brief: 'Review the neutral prepared fixture.',
          rationale: 'Disposable-only fixture establishes exact export lineage.',
          sourceProvenance: 'IMPORTED_FIXTURE',
          actor: agent,
        })
        const accepted = await decideCharacterCandidateReview({
          tenantId,
          venueId,
          briefId: brief.brief.id,
          expectedVersion: brief.brief.candidateVersion,
          expectedRevision: brief.brief.candidateRevision,
          expectedArtifactFingerprint: brief.brief.artifactFingerprint,
          decision: 'ACCEPT',
          operationId: `accept-${suffix}`,
          actor: human,
        })
        if (!accepted.resultingJob) throw new Error('Expected ACCEPT to queue export.')
        const exportClaim = await claimCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId: accepted.resultingJob.requestId,
        })
        if (exportClaim.state !== 'claimed') throw new Error('Expected disposable export claim.')
        const exported = spec(1, 2, 'exported')
        const exportBundle = await build(exported)
        await completeCharacterFactoryJobAction(
          {
            tenantId,
            venueId,
            requestId: accepted.resultingJob.requestId,
            leaseToken: exportClaim.job.leaseToken!,
            resultPayload: { callerSuppliedReceipt: 'must-not-be-authoritative' },
            characterSpec: exported,
            assetStorageReference: artifactReference(exportBundle),
            actor: human,
          },
          undefined,
          { verifyArtifact: () => verify(exportBundle) },
        )
        const runtime = await readCharacterRuntimePack(exportBundle)
        const asset = await readCharacterRuntimeAsset(exportBundle, { assetId: 'body' })
        expect(asset.bytes).toEqual(neutralBytes)
        const binding = {
          schemaVersion: 1 as const,
          characterId,
          decisionId: accepted.decision.id,
          exportJobId: accepted.resultingJob.id,
          characterVersion: exported.version,
          characterRevision: exported.revision,
          sourceSha256: exported.source.sha256,
          artifactSha256: exportBundle.sha256,
          artifactVersionId: artifactReference(exportBundle).versionId,
          runtimePackSha256: sha256(canonicalCharacterRuntimePack(runtime.runtimePack)),
        }
        const externalVerifier = async (
          evidence: CustomCharacterPublicationEvidence & { tenantId: string; venueId: string },
        ) => {
          expect(evidence).toMatchObject({ tenantId, venueId, runtimePack: runtime.runtimePack })
          await verifyNativeCustomCharacterPublication(evidence, dependencies)
        }
        const projected = await projectNativeVenueStateAction(db, { tenantId, venueId })
        const manifest = {
          schemaVersion: 2 as const,
          packageType: 'FULL' as const,
          materializationProfile: 'NATIVE_CORE_V1' as const,
          manifestId: randomUUID(),
          idempotencyKey: randomUUID(),
          venueRef: venueId,
          provenance: {
            sourceIds: ['disposable-character-publication'],
            evidenceIds: [],
            createdAt: new Date().toISOString(),
            createdBy: { kind: 'OPERATOR' as const, actorRef: human.id },
          },
          venue: projected.state.venue,
          venueBotConfiguration: {
            ...projected.state.venueBotConfiguration,
            presentationMode: 'CHARACTER' as const,
            characterKey: null,
            customCharacterId: characterId,
            publicDisplayName: 'Published fixture A',
          },
          customCharacterPublication: binding,
          places: projected.state.places,
          knowledgeEntries: projected.state.knowledgeEntries,
          generalizedModules: projected.state.generalizedModules,
          items: [],
          assets: [],
          capabilityOverrides: [],
          modelReferences: [],
          evaluation: {
            status: 'NOT_REQUIRED_FOR_CORE_PROFILE' as const,
            policyVersion: 'native-core-v1' as const,
          },
          baseState: { stateHash: projected.stateHash, ...projected.universe },
        }
        const release = await createNativeVenueDeploymentAction(
          { tenantId, venueId, actor: human, manifest },
          db,
          { verifyCustomCharacterPublication: externalVerifier },
        )
        const projectedForEvaluation = {
          state: {
            ...projected.state,
            venueBotConfiguration: manifest.venueBotConfiguration,
            customCharacterPublication: binding,
          },
        }
        const evalCase = await db.evalCase.create({
          data: {
            tenantId,
            venueId,
            caseKey: `native-guestread-${suffix}`,
            revision: 1,
            schemaVersion: 'fixture-v1',
            category: 'authorization-and-grounding',
            caseHash: 'a'.repeat(64),
            caseSnapshot: { prompt: 'Describe the authorized venue content.' },
            createdBy: human.id,
            sourceType: 'SYNTHETIC',
            sourceRef: `fixture:${suffix}`,
          },
        })
        const caseManifest = [
          { caseId: evalCase.id, revision: evalCase.revision, caseHash: evalCase.caseHash },
        ]
        const runId = randomUUID()
        const { run } = await createOrReplayEvaluationRun({
          db,
          runId,
          identity: {
            tenantId,
            venueId,
            idempotencyKey: `native-guestread-eval-${suffix}`,
            caseManifest,
            promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
            promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
            packageSnapshotRef: `native-core-v1:${release.id}`,
            packageSnapshotHash: release.manifestHash,
            contentSnapshotKind: 'NATIVE_CORE_V1',
            contentSnapshotRef: release.id,
            contentSnapshotVersion: 1n,
            contentSnapshotHash: release.desiredStateHash,
            modelProvider: 'deterministic-in-process',
            modelName: 'provider-dark-fixture',
            modelSnapshot: { provider: 'deterministic-in-process', model: 'provider-dark-fixture' },
            runConfigSnapshot: {
              version: 'pathfinder-native-evaluation-run-config-v1',
              maximumCases: 1,
              requestedCases: 1,
              contentSnapshotSchemaVersion: 'pathfinder-native-evaluation-content-v1',
              contentComponentCounts: {
                places: projectedForEvaluation.state.places.length,
                knowledgeEntries: projectedForEvaluation.state.knowledgeEntries.length,
                generalizedModules: projected.state.generalizedModules.length,
              },
              contentSnapshot: {
                version: 'pathfinder-native-evaluation-content-v1',
                tenantId,
                venueId,
                releaseId: release.id,
                state: JSON.parse(
                  JSON.stringify(projectedForEvaluation.state),
                ) as Prisma.InputJsonValue,
              },
            },
            declaredBudgetCeilingE8Usd: 0n,
            createdBy: human.id,
            triggerType: 'DISPOSABLE_REHEARSAL',
          },
        })
        const runScope = {
          runId: run.id,
          tenantId,
          venueId,
          runIdentityHash: run.identityHash,
        }
        expect(await markEvaluationRunQueued(runScope)).toBe(true)
        const claim = await claimEvaluationRunAttempt({
          ...runScope,
          attemptNumber: 1,
          maxAttempts: 1,
        })
        expect(claim.state).toBe('acquired')
        if (claim.state !== 'acquired')
          throw new Error('Disposable evaluation run was not acquired')
        await db.evalResult.create({
          data: {
            tenantId,
            venueId,
            runId: run.id,
            runIdentityHash: run.identityHash,
            caseId: evalCase.id,
            caseRevision: evalCase.revision,
            caseHash: evalCase.caseHash,
            outcome: 'SCORED',
            observationHash: 'b'.repeat(64),
            observationSnapshot: { answer: 'Deterministic provider-dark result.' },
            checksSnapshot: [{ check: 'grounding', passed: true }],
            passed: true,
            passedChecks: 1,
            totalChecks: 1,
            latencyMs: 1,
            costE8Usd: 0n,
          },
        })
        expect(
          await finishEvaluationRunAttempt({
            ...runScope,
            attemptNumber: claim.attemptNumber,
            leaseToken: claim.leaseToken,
            outcome: 'COMPLETED',
          }),
        ).toBe(true)
        const evidence = await recordNativeDeploymentEvaluationEvidenceAction(
          {
            tenantId,
            venueId,
            releaseId: release.id,
            runId: run.id,
            expectedRunIdentityHash: run.identityHash,
            operationId: randomUUID(),
            actor: human,
          },
          db,
        )
        await db.tenantFeatureFlag.createMany({
          data: [
            { tenantId, flagKey: 'venue-character-mode-v1', enabled: true, setBy: human.id },
            { tenantId, flagKey: 'character-registry-v1', enabled: true, setBy: human.id },
            {
              tenantId,
              flagKey: nativeGuestReadTenantFlagKey(venueId),
              enabled: true,
              setBy: human.id,
              metadata: {
                schemaVersion: 1,
                mode: 'ACTIVE',
                venueId,
                targetReleaseId: release.id,
                evaluationEvidenceId: evidence.id,
                qualityPolicyRef: 'fixture://deterministic-no-provider',
                rollbackRehearsalRef: 'fixture://this-revert-test',
                productionApprovalRef: null,
              },
            },
          ],
        })
        const differentButValidRuntimePack = {
          ...runtime.runtimePack,
          supportedContexts: ['marketing'] as CharacterRuntimePack['supportedContexts'],
        }
        await expect(
          createNativeVenueDeploymentAction(
            {
              tenantId,
              venueId,
              actor: human,
              manifest: {
                ...manifest,
                manifestId: randomUUID(),
                idempotencyKey: randomUUID(),
                customCharacterPublication: {
                  ...binding,
                  runtimePackSha256: sha256(
                    canonicalCharacterRuntimePack(differentButValidRuntimePack),
                  ),
                },
              },
            },
            db,
            { verifyCustomCharacterPublication: externalVerifier },
          ),
        ).rejects.toThrow('binding changed')
        const approved = (await approveNativeVenueDeploymentAction(
          {
            tenantId,
            venueId,
            releaseId: release.id,
            commandId: randomUUID(),
            expectedUpdatedAt: release.updatedAt.toISOString(),
            actor: human,
          },
          db,
          { verifyCustomCharacterPublication: externalVerifier },
        )) as { updatedAt: string }
        const applied = (await applyNativeVenueDeploymentAction(
          {
            tenantId,
            venueId,
            releaseId: release.id,
            commandId: randomUUID(),
            expectedUpdatedAt: approved.updatedAt,
            actor: human,
          },
          db,
          { verifyCustomCharacterPublication: externalVerifier },
        )) as { updatedAt: string; status: string }
        expect(applied.status).toBe('APPLIED')
        const publicA = await readCustomCharacterPublicationEvidence(db, {
          tenantId,
          venueId,
          binding,
          requireCurrentCandidate: false,
        })
        expect(publicA).toMatchObject({
          spec: { revision: 2, status: 'exported' },
          runtimePack: runtime.runtimePack,
        })
        const projectedA = await projectNativeVenueStateAction(db, { tenantId, venueId })
        expect(projectedA.state.customCharacterPublication).toEqual(binding)

        const publicScope = { tenantId, venueId, venueSlug: venueId }
        const assetInput = {
          venueSlug: venueId,
          releaseId: release.id,
          runtimePackSha256: binding.runtimePackSha256,
          assetPath: 'body.png',
        }
        const costBefore = { ...transfer }
        const started = performance.now()
        const apiA = await resolvePublishedCustomCharacterProjection(publicScope, dependencies)
        expect(apiA?.presentation).toMatchObject({
          mode: 'CHARACTER',
          displayName: 'Published fixture A',
        })
        expect(apiA?.character?.familyRig).toMatchObject({
          family: 'compact-creature-v1',
          canvas: { width: 10, height: 10 },
        })
        expect(JSON.stringify(apiA)).not.toMatch(
          /example\.invalid|sourceSha256|sourceRevision|objectKey|versionId|acceptedCandidate|characterVersion/,
        )
        const projectionCost = {
          elapsedMs: performance.now() - started,
          storageReads: transfer.reads - costBefore.reads,
          storageBytes: transfer.bytes - costBefore.bytes,
        }
        const assetStart = performance.now()
        const assetBefore = { ...transfer }
        const png = await readPublishedCustomCharacterAsset(assetInput, dependencies)
        expect(png?.mediaType).toBe('image/png')
        expect(png?.bytes).toEqual(Uint8Array.from(await sharp(neutralBytes).png().toBuffer()))
        expect(await sharp(png!.bytes).metadata()).toMatchObject({
          format: 'png',
          width: 10,
          height: 10,
        })
        process.stdout.write(
          'CHARACTER_PUBLICATION_API_COST ' +
            JSON.stringify({
              fixtureOnly: true,
              assetCount: 3,
              canvasPixels: 100,
              projection: projectionCost,
              asset: {
                elapsedMs: performance.now() - assetStart,
                storageReads: transfer.reads - assetBefore.reads,
                storageBytes: transfer.bytes - assetBefore.bytes,
                pngBytes: png!.bytes.length,
              },
            }) +
            '\n',
        )
        const noTransfer = { ...transfer }
        for (const invalid of [
          { ...assetInput, venueSlug: otherVenueId },
          { ...assetInput, releaseId: randomUUID() },
          { ...assetInput, runtimePackSha256: '0'.repeat(64) },
          { ...assetInput, assetPath: 'unknown.png' },
          { ...assetInput, assetPath: '../body.png' },
        ])
          expect(await readPublishedCustomCharacterAsset(invalid, dependencies)).toBeNull()
        expect(transfer).toEqual(noTransfer)
        expect(
          await readPublishedCustomCharacterAsset(assetInput, {
            ...dependencies,
            featureEnabled: () => false,
          }),
        ).toBeNull()
        await db.tenantFeatureFlag.update({
          where: { tenantId_flagKey: { tenantId, flagKey: 'character-registry-v1' } },
          data: { enabled: false },
        })
        expect(await readPublishedCustomCharacterAsset(assetInput, dependencies)).toBeNull()
        expect(
          await resolvePublishedCustomCharacterProjection(publicScope, dependencies),
        ).toBeNull()
        await db.tenantFeatureFlag.update({
          where: { tenantId_flagKey: { tenantId, flagKey: 'character-registry-v1' } },
          data: { enabled: true },
        })

        await prepareCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId: `draft-b-${suffix}`,
          action: 'REVISE',
          requestPayload: { instructions: 'Disposable draft B remains unpublished.' },
          characterId,
          baseVersion: exported.version,
          baseRevision: exported.revision,
          actor: human,
        })
        const draftBClaim = await claimCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId: `draft-b-${suffix}`,
        })
        if (draftBClaim.state !== 'claimed') throw new Error('Expected disposable draft B claim.')
        const draftB = spec(2, 3, 'candidate')
        const draftBBundle = await build(draftB)
        await completeCharacterFactoryJobAction(
          {
            tenantId,
            venueId,
            requestId: `draft-b-${suffix}`,
            leaseToken: draftBClaim.job.leaseToken!,
            resultPayload: { fixture: 'unpublished-draft-b' },
            characterSpec: draftB,
            assetStorageReference: artifactReference(draftBBundle),
            actor: human,
          },
          undefined,
          { verifyArtifact: () => verify(draftBBundle) },
        )
        const projectedAfterDraftB = await projectNativeVenueStateAction(db, { tenantId, venueId })
        expect(projectedAfterDraftB.state.customCharacterPublication).toEqual(binding)
        expect(projectedAfterDraftB.stateHash).toBe(projectedA.stateHash)
        const afterDraftB = await readCustomCharacterPublicationEvidence(db, {
          tenantId,
          venueId,
          binding,
          requireCurrentCandidate: false,
        })
        expect(afterDraftB).toEqual(publicA)
        await expect(
          readCustomCharacterPublicationEvidence(db, {
            tenantId,
            venueId,
            binding,
            requireCurrentCandidate: true,
          }),
        ).rejects.toThrow('newer custom character draft')

        expect(await resolvePublishedCustomCharacterProjection(publicScope, dependencies)).toEqual(
          apiA,
        )
        expect((await readPublishedCustomCharacterAsset(assetInput, dependencies))?.bytes).toEqual(
          png?.bytes,
        )
        // The exact immutable bundle may become unavailable independently of DB authority.
        retained.delete(artifactReference(exportBundle).versionId)
        expect(await readPublishedCustomCharacterAsset(assetInput, dependencies)).toBeNull()
        expect(
          await resolvePublishedCustomCharacterProjection(publicScope, dependencies),
        ).toMatchObject({ character: null, presentation: { mode: 'CLASSIC', character: null } })
        retained.set(artifactReference(exportBundle).versionId, exportBundle)

        const otherProjected = await projectNativeVenueStateAction(db, {
          tenantId,
          venueId: otherVenueId,
        })
        await expect(
          createNativeVenueDeploymentAction(
            {
              tenantId,
              venueId: otherVenueId,
              actor: human,
              manifest: {
                ...manifest,
                manifestId: randomUUID(),
                idempotencyKey: randomUUID(),
                venueRef: otherVenueId,
                venue: otherProjected.state.venue,
                venueBotConfiguration: {
                  ...otherProjected.state.venueBotConfiguration,
                  presentationMode: 'CHARACTER',
                  characterKey: null,
                  customCharacterId: characterId,
                },
                places: otherProjected.state.places,
                knowledgeEntries: otherProjected.state.knowledgeEntries,
                generalizedModules: otherProjected.state.generalizedModules,
                baseState: { stateHash: otherProjected.stateHash, ...otherProjected.universe },
              },
            },
            db,
            { verifyCustomCharacterPublication: externalVerifier },
          ),
        ).rejects.toThrow('lineage is unavailable')

        const reverted = await revertNativeVenueDeploymentAction(
          {
            tenantId,
            venueId,
            releaseId: release.id,
            commandId: randomUUID(),
            expectedUpdatedAt: applied.updatedAt,
            actor: human,
          },
          db,
        )
        expect(reverted).toMatchObject({ status: 'REVERTED', head: null })
        expect(await readPublishedCustomCharacterAsset(assetInput, dependencies)).toBeNull()
        expect(
          await resolvePublishedCustomCharacterProjection(publicScope, dependencies),
        ).toBeNull()
        const persistedExport = await db.characterFactoryJob.findUniqueOrThrow({
          where: { id: accepted.resultingJob.id },
          select: { resultPayload: true },
        })
        const originalReceipt = (
          persistedExport.resultPayload as unknown as {
            verifiedExportReceipt: {
              spec: CharacterSpec
              acceptedCandidate: { spec: CharacterSpec }
            }
          }
        ).verifiedExportReceipt
        await db.characterFactoryJob.update({
          where: { id: accepted.resultingJob.id },
          data: {
            resultPayload: {
              ...(persistedExport.resultPayload as object),
              verifiedExportReceipt: {
                ...originalReceipt,
                spec: { ...originalReceipt.spec, displayName: 'Forged historical display name' },
                acceptedCandidate: {
                  ...originalReceipt.acceptedCandidate,
                  spec: {
                    ...originalReceipt.acceptedCandidate.spec,
                    displayName: 'Forged historical display name',
                  },
                },
              },
            },
          },
        })
        await expect(
          readCustomCharacterPublicationEvidence(db, {
            tenantId,
            venueId,
            binding,
            requireCurrentCandidate: false,
          }),
        ).rejects.toThrow('no server verification evidence')
      }),
    45_000,
  )
})
