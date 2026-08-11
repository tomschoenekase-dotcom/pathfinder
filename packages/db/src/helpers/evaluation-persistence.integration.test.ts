import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVAL_SCHEMA_VERSION,
  type EvalCase as EvalCaseContract,
} from '@pathfinder/contracts/evaluation'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'

import { db } from '../client'
import { createOrReplayEvaluationCase } from './evaluation-cases'
import {
  createOrReplayEvaluationRun,
  EvaluationRunReplayConflictError,
  type EvaluationRunIdentity,
} from './evaluation-runs'

function isExplicitDisposableDatabase(): boolean {
  if (process.env.RUN_EVALUATION_DB_INTEGRATION !== '1') return false
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const database = decodeURIComponent(url.pathname.slice(1))
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      ['127.0.0.1', '::1', 'localhost'].includes(host) &&
      url.port.length > 0 &&
      /^pathfinder_disposable_[a-z0-9_]+$/.test(database)
    )
  } catch {
    return false
  }
}

const integrationDescribe = isExplicitDisposableDatabase() ? describe : describe.skip

integrationDescribe('evaluation persistence (disposable PostgreSQL integration)', () => {
  const suffix = randomUUID()
  const tenantId = `eval-tenant-${suffix}`
  const otherTenantId = `eval-other-tenant-${suffix}`
  const venueId = `eval-venue-${suffix}`
  const otherVenueId = `eval-other-venue-${suffix}`
  const observationHash = 'b'.repeat(64)
  let caseId = ''
  let caseHash = ''

  const caseSnapshot: EvalCaseContract = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    caseId: 'synthetic-known-answer',
    category: 'known-answer',
    venue: {
      fixtureId: 'integration-venue',
      guideMode: 'location_aware',
      placeNameUniverse: ['Tide Clock'],
      allowedPlaceNames: ['Tide Clock'],
    },
    turns: [{ role: 'user', content: 'Where is the Tide Clock?' }],
    rules: {
      requiredPhrases: [{ ruleId: 'subject', phrase: 'Tide Clock' }],
      requiredFacts: [],
      forbiddenPhrases: [],
      maxWords: 40,
      unknownAnswer: { required: false, ruleId: 'unknown-boundary', acceptablePhrases: [] },
    },
  }

  const identity = (overrides: Partial<EvaluationRunIdentity> = {}): EvaluationRunIdentity => ({
    tenantId,
    venueId,
    idempotencyKey: `eval-command-${suffix}`,
    caseManifest: [{ caseId, revision: 1, caseHash }],
    promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
    promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
    packageSnapshotRef: null,
    packageSnapshotHash: null,
    contentSnapshotVersion: 0n,
    contentSnapshotHash: 'e'.repeat(64),
    modelProvider: 'synthetic',
    modelName: 'deterministic-fixture',
    modelSnapshot: { providerCalls: false },
    runConfigSnapshot: { lexicalSmoke: true },
    declaredBudgetCeilingE8Usd: 0n,
    createdBy: 'integration-operator',
    triggerType: 'MANUAL',
    ...overrides,
  })

  beforeAll(async () => {
    await db.tenant.createMany({
      data: [
        { id: tenantId, name: 'Evaluation tenant', slug: tenantId },
        { id: otherTenantId, name: 'Other evaluation tenant', slug: otherTenantId },
      ],
    })
    await db.venue.createMany({
      data: [
        { id: venueId, tenantId, name: 'Evaluation venue', slug: venueId },
        {
          id: otherVenueId,
          tenantId: otherTenantId,
          name: 'Other evaluation venue',
          slug: otherVenueId,
        },
      ],
    })
    const created = await createOrReplayEvaluationCase({
      db,
      caseId: randomUUID(),
      identity: {
        tenantId,
        venueId,
        caseKey: 'synthetic-known-answer',
        revision: 1,
        schemaVersion: 'pathfinder-eval-v1',
        category: 'known-answer',
        caseSnapshot,
        createdBy: 'integration-operator',
        sourceType: 'SYNTHETIC_CORPUS',
        sourceRef: 'integration:synthetic-v1',
      },
    })
    caseId = created.evalCase.id
    caseHash = created.evalCase.caseHash
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it('enforces composite tenant and venue ownership', async () => {
    await expect(
      db.evalCase.create({
        data: {
          tenantId,
          venueId: otherVenueId,
          caseKey: 'cross-tenant-case',
          revision: 1,
          schemaVersion: 'pathfinder-eval-v1',
          category: 'known-answer',
          caseHash: '1'.repeat(64),
          caseSnapshot: { synthetic: true },
          createdBy: 'integration-operator',
          sourceType: 'SYNTHETIC_CORPUS',
          sourceRef: 'integration:cross-tenant',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
  })

  it('creates an exact run once, replays identically, and conflicts on changed identity', async () => {
    const runId = randomUUID()
    const first = await createOrReplayEvaluationRun({ db, runId, identity: identity() })
    expect(first.replayed).toBe(false)
    await expect(
      createOrReplayEvaluationRun({ db, runId: randomUUID(), identity: identity() }),
    ).resolves.toEqual({ run: first.run, replayed: true })
    await expect(
      createOrReplayEvaluationRun({
        db,
        runId: randomUUID(),
        identity: identity({ declaredBudgetCeilingE8Usd: 1n }),
      }),
    ).rejects.toBeInstanceOf(EvaluationRunReplayConflictError)
    expect(
      await db.evalRun.count({
        where: { tenantId, venueId, idempotencyKey: identity().idempotencyKey },
      }),
    ).toBe(1)
  })

  it('pins one immutable result to the exact run and case revision', async () => {
    const run = await db.evalRun.findFirstOrThrow({
      where: { tenantId, venueId, idempotencyKey: identity().idempotencyKey },
    })
    const storedCase = await db.evalCase.findFirstOrThrow({ where: { id: caseId, tenantId } })
    const data = {
      tenantId,
      venueId,
      runId: run.id,
      runIdentityHash: run.identityHash,
      caseId,
      caseRevision: 1,
      caseHash: storedCase.caseHash,
      outcome: 'SCORED' as const,
      observationHash,
      observationSnapshot: { answer: 'Synthetic answer' },
      checksSnapshot: [{ checkId: 'max-words', passed: true }],
      passed: true,
      passedChecks: 1,
      totalChecks: 1,
      latencyMs: 0,
      costE8Usd: 0n,
    } as const
    const result = await db.evalResult.create({ data })
    const review = await db.evalReview.create({
      data: {
        tenantId,
        venueId,
        resultId: result.id,
        reviewerId: 'reviewer_1',
        conclusion: 'Synthetic fixture accepted.',
        decision: 'ACCEPTED',
        rubricVersion: 'lexical-smoke-v1',
        revision: 1,
      },
    })
    await expect(
      db.evalReview.create({
        data: {
          tenantId: otherTenantId,
          venueId: otherVenueId,
          resultId: result.id,
          reviewerId: 'reviewer_2',
          conclusion: 'Cross-tenant review must not attach.',
          decision: 'REJECTED',
          rubricVersion: 'lexical-smoke-v1',
          revision: 2,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })

    await expect(db.evalResult.create({ data })).rejects.toMatchObject({ code: 'P2002' })
    await expect(
      db.$executeRaw`UPDATE eval_results SET latency_ms = 1 WHERE id = ${result.id}::uuid`,
    ).rejects.toThrow(/append-only/)
    await expect(db.$executeRaw`DELETE FROM eval_runs WHERE id = ${run.id}::uuid`).rejects.toThrow(
      /append-only/,
    )
    await expect(db.$executeRaw`DELETE FROM eval_cases WHERE id = ${caseId}::uuid`).rejects.toThrow(
      /append-only/,
    )
    await expect(
      db.$executeRaw`UPDATE eval_reviews SET conclusion = 'changed' WHERE id = ${review.id}::uuid`,
    ).rejects.toThrow(/append-only/)
    for (const table of ['eval_reviews', 'eval_results', 'eval_runs', 'eval_cases']) {
      await expect(db.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)).rejects.toThrow(
        /append-only/,
      )
    }
  })

  it('stores a non-scored operational terminal outcome without a quality failure', async () => {
    const run = await createOrReplayEvaluationRun({
      db,
      runId: randomUUID(),
      identity: identity({ idempotencyKey: `operational-${suffix}`, triggerType: 'SCHEDULED' }),
    })
    const storedCase = await db.evalCase.findFirstOrThrow({ where: { id: caseId, tenantId } })
    const result = await db.evalResult.create({
      data: {
        tenantId,
        venueId,
        runId: run.run.id,
        runIdentityHash: run.run.identityHash,
        caseId,
        caseRevision: 1,
        caseHash: storedCase.caseHash,
        outcome: 'ADMISSION_DEFERRED',
        errorCode: 'VENUE_AI_PAUSED',
        latencyMs: 0,
        costE8Usd: 0n,
      },
    })
    expect(result).toMatchObject({
      outcome: 'ADMISSION_DEFERRED',
      passed: null,
      observationHash: null,
      errorCode: 'VENUE_AI_PAUSED',
    })
  })
})
