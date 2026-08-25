import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  readPlatformReleaseEvidence,
  recordPlatformReleaseEvidenceAction,
} from './platform-release-evidence'

const enabled =
  process.env.RUN_PLATFORM_RELEASE_EVIDENCE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_release_evidence_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const assessment = (revision: string, generatedAt: string) => ({
  schemaVersion: 1 as const,
  generatedAt,
  revision,
  profile: 'candidate' as const,
  readiness: 'ready-for-staging-review' as const,
  repository: { clean: true },
  summary: { passed: 3, failed: 0, blocked: 0 },
  gates: [
    { id: 'tenant-isolation', status: 'pass' as const, durationMs: 20 },
    { id: 'visual-browser', status: 'pass' as const, durationMs: 30 },
    { id: 'accessibility', status: 'pass' as const, durationMs: 40 },
  ],
  limitations: ['Hosted provider behavior remains a separate evidence gate.'],
  rollback: {
    application: 'Redeploy the last admitted immutable staging revision.',
    database: 'Stop writers and repair forward.',
    runbook: 'docs/staging-release-workflow.md',
  },
})

const handoff = {
  artifactSha256: '1'.repeat(64),
  status: 'ready-for-owner-staging-integration' as const,
  baseRevision: '2'.repeat(40),
  baseIsAncestor: true,
  ahead: 3,
  behind: 0,
  changedFiles: 20,
  patchSha256: '3'.repeat(64),
  migrationCount: 183,
  latestMigration: '20260825007000_add_operational_usage_evidence',
  migrationChainSha256: '4'.repeat(64),
  requiredActions: ['Integrate the exact candidate into staging.'],
  retainedGates: ['No production deployment or migration is authorized.'],
}

describe.skipIf(!enabled)('platform release evidence disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('proves durable release evidence without deployment or customer-system effects', async () => {
    const baseline = await withTenantIsolationBypass(async () => ({
      tenants: await db.tenant.count(),
      venues: await db.venue.count(),
      billing: await db.billingAccount.count(),
      outbox: await db.prospectSendOutbox.count(),
    }))
    const humanOperationId = randomUUID()
    const humanInput = {
      operationId: humanOperationId,
      assessment: assessment('a'.repeat(40), '2026-08-25T04:01:22.858Z'),
      stagingHandoff: handoff,
      sourceReference: 'artifact://release/human-candidate.json',
      actor: { type: 'HUMAN' as const, id: 'founder-disposable', role: 'PLATFORM_ADMIN' as const },
    }
    const created = await recordPlatformReleaseEvidenceAction(humanInput)
    expect(created).toMatchObject({ replayed: false, deduplicated: false })
    await expect(recordPlatformReleaseEvidenceAction(humanInput)).resolves.toMatchObject({
      id: created.id,
      replayed: true,
    })
    await expect(
      recordPlatformReleaseEvidenceAction({ ...humanInput, operationId: randomUUID() }),
    ).resolves.toMatchObject({ id: created.id, replayed: true, deduplicated: true })

    const credential = await db.platformWorkerPolicyCredential.create({
      data: {
        issueOperationId: randomUUID(),
        issueOperationHash: '5'.repeat(64),
        workerId: 'release-worker-disposable',
        label: 'Disposable release evidence worker',
        capabilities: ['release-evidence:read', 'release-evidence:record'],
        secretPrefix: `pf_platform_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        secretHash: 'disposable-not-a-real-secret-hash',
        enabled: true,
        createdBy: 'founder-disposable',
        activatedBy: 'founder-disposable',
        activatedAt: new Date(),
        activationOperationId: randomUUID(),
        activationHash: '8'.repeat(64),
      },
    })
    const machine = await recordPlatformReleaseEvidenceAction({
      operationId: randomUUID(),
      assessment: assessment('b'.repeat(40), '2026-08-25T05:01:22.858Z'),
      stagingHandoff: { ...handoff, artifactSha256: '6'.repeat(64), patchSha256: '7'.repeat(64) },
      sourceReference: 'artifact://release/machine-candidate.json',
      actor: {
        type: 'AGENT',
        id: credential.workerId,
        credentialId: credential.id,
        capability: 'release-evidence:record',
      },
    })
    expect(machine.recordedByType).toBe('AGENT')

    const projection = await readPlatformReleaseEvidence(5)
    expect(projection.current?.id).toBe(machine.id)
    expect(projection.items).toHaveLength(2)
    expect(projection.boundaries).toMatchObject({
      evidenceOnly: true,
      stagingDeploymentAuthorized: false,
      productionDeploymentAuthorized: false,
      customerContactAuthorized: false,
      liveBillingAuthorized: false,
    })

    await expect(
      db.platformReleaseEvidence.update({
        where: { id: created.id },
        data: { readiness: 'not-ready' },
      }),
    ).rejects.toThrow(/append-only/iu)
    await expect(db.platformReleaseEvidence.delete({ where: { id: created.id } })).rejects.toThrow(
      /append-only/iu,
    )

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: 'platform-release-evidence.recorded', targetId: machine.id },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).toMatchObject({
      actorType: 'AGENT',
      credentialId: credential.id,
      capability: 'release-evidence:record',
    })
    expect(audit.afterState).toMatchObject({
      deploysApplication: false,
      runsMigration: false,
      authorizesProduction: false,
      contactsCustomer: false,
      changesBilling: false,
    })

    const after = await withTenantIsolationBypass(async () => ({
      tenants: await db.tenant.count(),
      venues: await db.venue.count(),
      billing: await db.billingAccount.count(),
      outbox: await db.prospectSendOutbox.count(),
    }))
    expect(after).toEqual(baseline)
  })
})
