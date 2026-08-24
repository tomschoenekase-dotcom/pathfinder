import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'

vi.mock('@pathfinder/config', () => ({
  env: { OPENAI_API_KEY: 'provider-dark-test-key' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }))
vi.mock('./lib/guest-query-embedding', () => ({
  generateGuestQueryEmbedding: vi.fn(
    async (
      _text: string,
      _usageSink: unknown,
      _admissionGuard: unknown,
      _budgetGate: unknown,
      _invocationId: string | undefined,
      onBeforeFirstDispatch: (() => Promise<void>) | undefined,
    ) => {
      await onBeforeFirstDispatch?.()
      return null
    },
  ),
}))

import { logger } from '@pathfinder/config'
import {
  applyNativeVenueDeploymentAction,
  approveNativeVenueDeploymentAction,
  claimEvaluationRunAttempt,
  createOrReplayEvaluationRun,
  createNativeVenueDeploymentAction,
  db,
  finishEvaluationRunAttempt,
  markEvaluationRunQueued,
  projectNativeVenueStateAction,
  recordNativeDeploymentEvaluationEvidenceAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { nativeGuestReadTenantFlagKey } from '@pathfinder/config/feature-flags'

import type { TRPCContext } from './context'
import { router } from './core'
import { _setAnthropicClientForTesting, chatRouter } from './routers/chat'

const enabled =
  process.env.RUN_NATIVE_GUEST_READ_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_native_guest_read_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('native guest content read disposable rehearsal', () => {
  const testRouter = router({ chat: chatRouter })

  afterAll(async () => {
    _setAnthropicClientForTesting(null)
    await db.$disconnect()
  })

  it('rehearses active, dark, authorization, fallback, isolation, and kill-switch behavior', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-guestread-${suffix}`
      const controlTenantId = `tenant-guestread-control-${suffix}`
      const venueId = `venue-guestread-${suffix}`
      const controlVenueId = `venue-guestread-control-${suffix}`
      const publicPlaceId = `place-public-${suffix}`
      const employeePlaceId = `place-employee-${suffix}`
      const secondLayerKey = randomUUID()
      const actor = {
        type: 'HUMAN' as const,
        role: 'PLATFORM_ADMIN' as const,
        id: 'disposable-guestread-operator',
      }

      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Disposable guest-read tenant', slug: tenantId },
          {
            id: controlTenantId,
            name: 'Disposable guest-read control tenant',
            slug: controlTenantId,
          },
        ],
      })
      await db.venue.createMany({
        data: [
          {
            id: venueId,
            tenantId,
            name: 'Native guest-read venue',
            slug: venueId,
            guideMode: 'non_location',
            secondLayerEnabled: true,
            secondLayerAccessKey: secondLayerKey,
          },
          {
            id: controlVenueId,
            tenantId: controlTenantId,
            name: 'Legacy control venue',
            slug: controlVenueId,
            guideMode: 'non_location',
          },
        ],
      })
      await db.place.createMany({
        data: [
          {
            id: publicPlaceId,
            tenantId,
            venueId,
            name: 'Native Public Gallery',
            shortDescription: 'Public native release content.',
            type: 'EXHIBIT',
            visibility: 'PUBLIC',
            importanceScore: 100,
            tags: ['public'],
          },
          {
            id: employeePlaceId,
            tenantId,
            venueId,
            name: 'Native Staff Room',
            shortDescription: 'Second-layer native release content.',
            type: 'ROOM',
            visibility: 'SECOND_LAYER',
            importanceScore: 90,
            tags: ['employee'],
          },
          {
            id: `place-control-${suffix}`,
            tenantId: controlTenantId,
            venueId: controlVenueId,
            name: 'Legacy Control Gallery',
            shortDescription: 'Control venue compatibility content.',
            type: 'EXHIBIT',
            visibility: 'PUBLIC',
            importanceScore: 100,
            tags: ['control'],
          },
        ],
      })

      const projected = await projectNativeVenueStateAction(db, { tenantId, venueId })
      const release = await createNativeVenueDeploymentAction(
        {
          tenantId,
          venueId,
          actor,
          manifest: {
            schemaVersion: 2,
            packageType: 'FULL',
            materializationProfile: 'NATIVE_CORE_V1',
            manifestId: randomUUID(),
            idempotencyKey: randomUUID(),
            venueRef: venueId,
            provenance: {
              sourceIds: ['synthetic:native-guest-read-rehearsal'],
              evidenceIds: [],
              createdAt: new Date().toISOString(),
              createdBy: { kind: 'OPERATOR', actorRef: actor.id },
            },
            venue: projected.state.venue,
            venueBotConfiguration: projected.state.venueBotConfiguration,
            places: projected.state.places,
            knowledgeEntries: projected.state.knowledgeEntries,
            generalizedModules: projected.state.generalizedModules,
            items: [],
            assets: [],
            capabilityOverrides: [],
            modelReferences: [],
            evaluation: {
              status: 'NOT_REQUIRED_FOR_CORE_PROFILE',
              policyVersion: 'native-core-v1',
            },
            baseState: { stateHash: projected.stateHash, ...projected.universe },
          },
        },
        db,
      )

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
          createdBy: actor.id,
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
              places: projected.state.places.length,
              knowledgeEntries: projected.state.knowledgeEntries.length,
              generalizedModules: projected.state.generalizedModules.length,
            },
            contentSnapshot: {
              version: 'pathfinder-native-evaluation-content-v1',
              tenantId,
              venueId,
              releaseId: release.id,
              state: projected.state,
            },
          },
          declaredBudgetCeilingE8Usd: 0n,
          createdBy: actor.id,
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
      if (claim.state !== 'acquired') throw new Error('Disposable evaluation run was not acquired')
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
          actor,
        },
        db,
      )
      const approved = (await approveNativeVenueDeploymentAction(
        {
          tenantId,
          venueId,
          releaseId: release.id,
          commandId: randomUUID(),
          expectedUpdatedAt: release.updatedAt.toISOString(),
          actor,
        },
        db,
      )) as { updatedAt: string }
      await applyNativeVenueDeploymentAction(
        {
          tenantId,
          venueId,
          releaseId: release.id,
          commandId: randomUUID(),
          expectedUpdatedAt: approved.updatedAt,
          actor,
        },
        db,
      )

      const policy = (mode: 'DARK' | 'ACTIVE') => ({
        schemaVersion: 1,
        mode,
        venueId,
        targetReleaseId: release.id,
        evaluationEvidenceId: evidence.id,
        qualityPolicyRef: 'policy://disposable-quality-proof',
        rollbackRehearsalRef: 'evidence://this-disposable-rehearsal',
        productionApprovalRef: null,
      })
      await db.tenantFeatureFlag.create({
        data: {
          tenantId,
          flagKey: nativeGuestReadTenantFlagKey(venueId),
          enabled: true,
          metadata: policy('ACTIVE'),
          setBy: actor.id,
        },
      })

      const anthropicCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Provider-dark guest response.' }],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      })
      _setAnthropicClientForTesting({
        messages: { create: anthropicCreate },
      } as AnthropicMessagesClient)

      const context = (employee = false): TRPCContext => ({
        db,
        headers: new Headers(),
        session: employee
          ? { userId: actor.id, activeTenantId: tenantId, role: 'OWNER', isPlatformAdmin: false }
          : { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      })
      const promptAt = (index: number) =>
        (anthropicCreate.mock.calls[index]![0].system as Array<{ text: string }>)
          .map((block) => block.text)
          .join('')
      const send = async (input: { venueId?: string; employee?: boolean; secondLayer?: boolean }) =>
        testRouter.createCaller(context(input.employee)).chat.send({
          venueId: input.venueId ?? venueId,
          anonymousToken: randomUUID(),
          operationId: randomUUID(),
          message: 'What should I know?',
          ...(input.secondLayer ? { secondLayerKey } : {}),
        })

      await send({})
      expect(promptAt(0)).toContain('Native Public Gallery')
      expect(promptAt(0)).not.toContain('Native Staff Room')
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'guest-chat.native-content-read',
          venueId,
          readPath: 'NATIVE',
          gateReason: 'NATIVE_READY',
        }),
      )

      await send({ employee: true, secondLayer: true })
      expect(promptAt(1)).toContain('Native Public Gallery')
      expect(promptAt(1)).toContain('Native Staff Room')

      await db.tenantFeatureFlag.update({
        where: { tenantId_flagKey: { tenantId, flagKey: nativeGuestReadTenantFlagKey(venueId) } },
        data: { metadata: policy('DARK') },
      })
      await send({})
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ readPath: 'DARK', gateReason: 'NATIVE_READY' }),
      )

      await send({ venueId: controlVenueId })
      expect(promptAt(3)).toContain('Legacy Control Gallery')
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tenantId: controlTenantId,
          venueId: controlVenueId,
          readPath: 'LEGACY',
          gateReason: 'POLICY_MISSING',
        }),
      )

      await db.tenantFeatureFlag.update({
        where: { tenantId_flagKey: { tenantId, flagKey: nativeGuestReadTenantFlagKey(venueId) } },
        data: { metadata: policy('ACTIVE') },
      })
      const legacyOnlyName = 'Legacy Only Emergency Exhibit'
      await db.place.create({
        data: {
          tenantId,
          venueId,
          name: legacyOnlyName,
          shortDescription: 'Absent from the immutable native snapshot.',
          type: 'EXHIBIT',
          visibility: 'PUBLIC',
          importanceScore: 200,
          tags: ['fallback'],
        },
      })
      await send({})
      expect(promptAt(4)).toContain(legacyOnlyName)
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ readPath: 'LEGACY', gateReason: 'NATIVE_READY' }),
      )

      await db.place.deleteMany({ where: { tenantId, venueId, name: legacyOnlyName } })
      await db.place.update({
        where: { id: publicPlaceId },
        data: { name: 'Kill Switch Compatibility Gallery' },
      })
      process.env.NATIVE_GUEST_CONTENT_READ_ENABLED = 'false'
      const logCountBeforeKillSwitch = vi.mocked(logger.info).mock.calls.length
      try {
        await send({})
      } finally {
        process.env.NATIVE_GUEST_CONTENT_READ_ENABLED = 'true'
      }
      expect(promptAt(5)).toContain('Kill Switch Compatibility Gallery')
      expect(vi.mocked(logger.info).mock.calls).toHaveLength(logCountBeforeKillSwitch)
    })
  }, 120_000)
})
