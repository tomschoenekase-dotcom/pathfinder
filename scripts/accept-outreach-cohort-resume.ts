/** Repeatable native SQL recovery acceptance. Existing synthetic rows only;
 * every write rolls back. No auth, model generation or live delivery claim. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const target = 'torchiko_outreach_acceptance_20260923_r001'
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.OUTREACH_ACCEPTANCE, target)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, '58617')
  assert.equal(url.pathname, `/${target}`)
  assert.equal(process.env.DIRECT_DATABASE_URL, process.env.DATABASE_URL)
  assert.equal(process.env.TORCHIKO_LOCAL_CRM_SALES_ENABLED, undefined)
  const { db, readNativeSalesSnapshot, withTenantIsolationBypass } =
    await import('../packages/db/src/index')
  const { createOutreachCohortService } =
    await import('../packages/api/src/prospect-outreach-cohort')
  const { cohortHash } = await import('../packages/api/src/prospect-outreach-cohort-contract')
  const original = JSON.parse(
    await readFile(path.resolve(__dirname, '../../qa/NATIVE-COHORT-PROOF.json'), 'utf8'),
  )
  const actor = {
    id: 'synthetic:outreach-acceptance-r001',
    type: 'HUMAN' as const,
    runId: 'synthetic-fresh-session-resume',
    scope: { mode: 'ALL' as const },
    capabilities: ['prospects.read', 'prospects.correspondence.read', 'prospects.maintain'],
  }
  const clock = new Date('2026-09-23T21:00:00Z'),
    checks: string[] = []
  const digest = async () => {
    const state = {
      campaigns: await db.prospectOutreachCampaign.findMany({ orderBy: { id: 'asc' } }),
      members: await db.prospectCampaignMember.findMany({ orderBy: { id: 'asc' } }),
      drafts: await db.prospectOutreachDraft.findMany({ orderBy: { id: 'asc' } }),
      activities: await db.prospectActivity.findMany({ orderBy: { id: 'asc' } }),
      venues: await db.prospectVenue.count(),
      accounts: await db.correspondenceProviderAccount.count(),
      batches: await db.prospectSendBatch.count(),
      items: await db.prospectSendItem.count(),
    }
    assert.equal(state.venues, 106)
    assert.equal(state.accounts, 0)
    assert.equal(state.batches, 0)
    assert.equal(state.items, 0)
    return cohortHash(JSON.parse(JSON.stringify(state)))
  }
  const rollback = new Error('COMPLETED_SYNTHETIC_ACCEPTANCE_ROLLBACK')
  let firstReview: unknown, listing: unknown
  try {
    const before = await withTenantIsolationBypass(digest)
    try {
      await withTenantIsolationBypass(() =>
        db.$transaction(
          async (tx) => {
            const client = new Proxy(tx, {
              get(object, key) {
                return key === '$transaction'
                  ? async (callback: (connection: typeof tx) => unknown) => callback(tx)
                  : Reflect.get(object, key)
              },
            })
            const prepared = new Map<string, { id: string; preparationId: string }>()
            const readView = async (venueId: string) => {
              const native = await readNativeSalesSnapshot(venueId, tx)
              const draft = await tx.prospectOutreachDraft.findFirst({
                where: { venueId },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              })
              const task = prepared.get(venueId)
              return {
                venueId,
                organizationId: native.organization.id,
                name: native.venue.name,
                snapshotHash: native.snapshotHash,
                routing: { kind: 'email', value: native.contacts[0]?.normalizedEmail ?? null },
                suppression: native.suppression,
                sourceState: 'EXPLICIT_SYNTHETIC_ACCEPTANCE_PROJECTION',
                sourceCount: native.sources.length,
                draft: draft
                  ? {
                      id: draft.id,
                      version: draft.version,
                      contentHash: draft.contentHash,
                      subject: draft.subject,
                      body: draft.textBody,
                      state: 'DRAFT_REVIEW',
                      writerAttribution: null,
                    }
                  : null,
                preparation:
                  draft || task
                    ? { id: task?.preparationId ?? 'synthetic-preparation', stale: false }
                    : null,
                writerTask: task
                  ? { taskId: task.id, binding: { recipient: native.contacts[0]?.normalizedEmail } }
                  : null,
                writerHold: null,
                blocker: null,
                threadCandidates: [],
                operational: null,
                outreachState: draft ? 'DRAFT_REVIEW' : 'UNPREPARED',
                correspondenceState: 'NO_RETAINED_HISTORY',
                SEND_AUTHORIZED: false,
              } as any
            }
            const service = createOutreachCohortService({
              client: client as any,
              readView,
              now: () => clock,
            })
            const firstPage = await service.list({ limit: 1 }, actor)
            assert.equal(firstPage.items.length, 1)
            assert.ok(firstPage.nextCursor)
            const secondPage = await service.list({ limit: 1, cursor: firstPage.nextCursor }, actor)
            assert.equal(secondPage.items.length, 1)
            assert.equal(secondPage.nextCursor, null)
            assert.notEqual(firstPage.items[0]!.cohortId, secondPage.items[0]!.cohortId)
            assert.deepEqual(
              new Set([...firstPage.items, ...secondPage.items].map((v) => v.cohortId)),
              new Set([original.firstCohortId, original.secondCohortId]),
            )
            listing = [firstPage, secondPage]
            await assert.rejects(service.list({ limit: 51 }, actor))
            await assert.rejects(service.list({}, { ...actor, capabilities: ['prospects.read'] }))
            assert.equal(
              (
                await service.list(
                  {},
                  { ...actor, scope: { mode: 'TERRITORIES', territoryIds: ['NOT_GRANTED'] } },
                )
              ).items.length,
              0,
            )
            checks.push(
              'actual service list exists; native stable cursor pagination returns both preserved 50-member groups; bounds and scope enforced',
            )
            const cohortId = original.firstCohortId
            let review = await service.read({ cohortId }, actor)
            assert.equal(review.count, 50)
            assert.equal(review.rows.length, 50)
            assert.equal(review.rows.filter((r) => r.draft).length, 1)
            assert.ok(review.recoverableWork.length > 0)
            assert.equal(
              (await service.read({ cohortId }, { ...actor, id: 'synthetic:other-actor' }))
                .recoverableWork.length,
              0,
            )
            assert.ok(!JSON.stringify(review.rows).includes('leaseToken'))
            firstReview = review
            checks.push(
              'fresh process reopens all 50 exact rows and original actor recovery references; another actor receives no retained lease tokens',
            )
            const pause = {
              cohortId,
              requestKey: 'resume-proof-pause',
              action: 'pause' as const,
              reason: 'Synthetic pause preserves every selected record and draft.',
              expectedReviewHash: review.reviewHash,
            }
            await assert.rejects(service.control(pause, { ...actor, type: 'AGENT' }))
            await assert.rejects(
              service.control({ ...pause, expectedReviewHash: '0'.repeat(64) }, actor),
            )
            assert.equal((await service.control(pause, actor)).status, 'PAUSED')
            assert.equal((await service.control(pause, actor)).replayed, true)
            await assert.rejects(
              service.control(
                { ...pause, reason: 'Different request body under the same key.' },
                actor,
              ),
            )
            await assert.rejects(
              service.claimWindow({ cohortId, requestKey: 'paused-claim', limit: 1 }, actor),
            )
            review = await service.read({ cohortId }, actor)
            assert.equal(review.status, 'PAUSED')
            assert.equal(review.preparationAvailable, false)
            const cancel = {
              ...pause,
              requestKey: 'resume-proof-cancel',
              action: 'cancel' as const,
              expectedReviewHash: review.reviewHash,
            }
            assert.equal((await service.control(cancel, actor)).status, 'CANCELLED')
            await assert.rejects(
              service.claimWindow({ cohortId, requestKey: 'cancelled-claim', limit: 1 }, actor),
            )
            const candidates = Array.from({ length: 105 }, (_, i) => ({
              venueId: `SYN-OUTREACH-VENUE-${String(i + 1).padStart(3, '0')}`,
              contactId: `SYN-OUTREACH-CONTACT-${String(i + 1).padStart(3, '0')}`,
            }))
            const next = await service.preview(
              {
                question:
                  'Another synthetic group must exclude both retained groups, including cancelled work.',
                candidates,
                count: 50,
                excludePriorGroups: true,
              },
              actor,
            )
            assert.equal(next.excludedCount, 100)
            assert.equal(next.selectedCount, 5)
            assert.equal(next.shortfall, 45)
            review = await service.read({ cohortId }, actor)
            await service.control(
              {
                ...pause,
                requestKey: 'resume-proof-resume',
                action: 'resume',
                expectedReviewHash: review.reviewHash,
              },
              actor,
            )
            checks.push(
              'human-only exact-hash pause/cancel/resume, immutable retry, changed-key-body rejection; cancelled groups remain excluded from next-50',
            )
            const window = (await service.claimWindow(
              { cohortId, requestKey: 'resume-proof-window', limit: 1 },
              actor,
            )) as any
            assert.equal(window.claims.length, 1)
            const claim = window.claims[0]
            const release = {
              action: 'release' as const,
              cohortId,
              memberId: claim.memberId,
              leaseToken: claim.lease.token,
              reason:
                'Synthetic interrupted attempt released without discarding its native history.',
            }
            assert.equal((await service.checkpoint(release, actor)).state, 'RELEASED')
            assert.equal((await service.checkpoint(release, actor)).replayed, true)
            await assert.rejects(service.checkpoint({ ...release, action: 'hold' }, actor))
            review = await service.read({ cohortId }, actor)
            const member = review.rows.find((r) => r.memberId === claim.memberId)!
            await service.checkpoint(
              {
                action: 'resume',
                cohortId,
                memberId: member.memberId,
                expectedSelectionHash: member.selectionHash,
                reason: 'Synthetic explicit resume rechecks the current exact native candidate.',
              },
              actor,
            )
            const nextWindow = (await service.claimWindow(
              { cohortId, requestKey: 'resume-proof-new-lease', limit: 1 },
              actor,
            )) as any
            assert.equal(nextWindow.claims[0].memberId, member.memberId)
            assert.notEqual(nextWindow.claims[0].lease.token, claim.lease.token)
            await assert.rejects(service.checkpoint(release, actor))
            const current = nextWindow.claims[0]
            prepared.set(current.venueId, {
              id: 'synthetic-resume-task',
              preparationId: 'synthetic-resume-preparation',
            })
            await service.checkpoint(
              {
                action: 'prepared',
                cohortId,
                memberId: current.memberId,
                leaseToken: current.lease.token,
                taskId: 'synthetic-resume-task',
                preparationId: 'synthetic-resume-preparation',
              },
              actor,
            )
            assert.equal(
              (await service.checkpoint({ ...release, leaseToken: current.lease.token }, actor))
                .state,
              'IMPORT_RECOVERY_REQUIRED',
            )
            review = await service.read({ cohortId }, actor)
            await assert.rejects(
              service.checkpoint(
                {
                  action: 'resume',
                  cohortId,
                  memberId: current.memberId,
                  expectedSelectionHash: review.rows.find((r) => r.memberId === current.memberId)!
                    .selectionHash,
                  reason: 'This must not erase an uncertain native writer task.',
                },
                actor,
              ),
            )
            await assert.rejects(
              service.checkpoint(
                {
                  action: 'imported',
                  cohortId,
                  memberId: current.memberId,
                  leaseToken: current.lease.token,
                  receiptId: 'FORGED-RECEIPT',
                  draftId: 'FORGED-DRAFT',
                },
                actor,
              ),
            )
            checks.push(
              'release without task remains explicitly resumable; new lease fences old attempts; uncertain task release requires native receipt recovery, never regeneration',
            )
            assert.equal(await tx.prospectOutreachDraft.count(), 1)
            assert.equal(
              await tx.prospectOutreachDraft.count({ where: { approvedAt: { not: null } } }),
              0,
            )
            assert.equal(await tx.prospectSendBatch.count(), 0)
            assert.equal(await tx.prospectSendItem.count(), 0)
            assert.equal(await tx.correspondenceProviderAccount.count(), 0)
            throw rollback
          },
          { isolationLevel: 'Serializable', timeout: 90000, maxWait: 10000 },
        ),
      )
    } catch (error) {
      if (error !== rollback) throw error
    }
    const after = await withTenantIsolationBypass(digest)
    assert.equal(after, before, 'Acceptance writes did not roll back exactly')
    checks.push(
      'native before/after database digest identical; no rows reset/deleted; no approved draft, provider account or sending item created',
    )
    const file = path.resolve(__dirname, `../../qa/RESUME-NATIVE-COHORT-PROOF-${Date.now()}.json`)
    await writeFile(
      file,
      JSON.stringify(
        {
          schema: 'torchiko.native-cohort-resume-proof/1',
          passed: true,
          target,
          checks,
          databaseBeforeSha256: before,
          databaseAfterSha256: after,
          listing,
          firstReview,
          syntheticReadProjection: true,
          authenticatedTransportProven: false,
          actualModelGeneration: 'Separate retained NATIVE-CODEX-PROOF.json',
          rolledBackAllChanges: true,
          SEND_AUTHORIZED: false,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    )
    console.log(JSON.stringify({ passed: true, checks, proof: file, SEND_AUTHORIZED: false }))
  } finally {
    await db.$disconnect()
  }
}
void main().catch((error) => {
  console.error(error.stack)
  process.exitCode = 1
})
