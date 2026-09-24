/** Source-only disposable acceptance, not real model writing or authenticated
 * business access. The independent NATIVE-CODEX-PROOF covers the actual writer.
 * This suite exercises native SQL campaign/member persistence and recovery. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
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
  const checks: string[] = []
  try {
    const proof = await withTenantIsolationBypass(() =>
      db.$transaction(
        async (tx) => {
          assert.equal(
            await tx.prospectVenue.count(),
            0,
            'Acceptance target must be empty; do not reset another run.',
          )
          const fixtureActor = 'synthetic:outreach-acceptance-r001'
          const timestamps = { createdBy: fixtureActor, updatedBy: fixtureActor }
          const territoryId = 'SYN-OUTREACH-TERRITORY',
            modelVersion = 'SYN-OUTREACH-GEO-FIXTURE'
          await tx.prospectTerritory.create({
            data: {
              id: territoryId,
              code: territoryId,
              name: 'Synthetic acceptance only',
              ...timestamps,
            },
          })
          await tx.prospectGeographyModel.create({
            data: {
              version: modelVersion,
              registryHash: cohortHash(modelVersion),
              countyVintage: 'SYNTHETIC-FIXTURE',
              approvalReference: 'fixture-only:not-human-geography-approval',
              approvedAt: new Date('2026-09-23T00:00:00Z'),
              approvedBy: fixtureActor,
              sourceManifest: { synthetic: true },
            },
          })
          await tx.prospectTerritoryDefinition.create({
            data: {
              modelVersion,
              code: territoryId,
              territoryId,
              name: 'Synthetic acceptance county',
              kind: 'FIXTURE',
              states: ['IL'],
            },
          })
          await tx.prospectCountyAssignment.create({
            data: {
              modelVersion,
              countyGeoid: '17031',
              territoryCode: territoryId,
              territoryId,
              state: 'IL',
              countyName: 'Synthetic fixture uses Cook identifier; not researched evidence',
            },
          })
          const selections = []
          for (let i = 1; i <= 105; i++) {
            const suffix = String(i).padStart(3, '0'),
              organizationId = `SYN-OUTREACH-ORG-${suffix}`,
              venueId = `SYN-OUTREACH-VENUE-${suffix}`,
              contactId = `SYN-OUTREACH-CONTACT-${suffix}`,
              name = `Synthetic Museum ${suffix}`,
              email = `fixture-${suffix}@example.invalid`,
              sourceUrl = `https://fixture-${suffix}.example.invalid/about`
            await tx.prospectOrganization.create({
              data: {
                id: organizationId,
                canonicalName: name,
                normalizedName: name.toLowerCase(),
                territoryId,
                source: 'EXPLICIT_SYNTHETIC_ACCEPTANCE_ONLY',
                ...timestamps,
              },
            })
            await tx.prospectVenue.create({
              data: {
                id: venueId,
                organizationId,
                territoryId,
                name,
                normalizedName: name.toLowerCase(),
                city: i % 2 ? 'Chicago' : 'Evanston',
                region: 'IL',
                estimatedSize: 'small',
                ...timestamps,
              },
            })
            await tx.prospectContact.create({
              data: {
                id: contactId,
                organizationId,
                venueId,
                email,
                normalizedEmail: email,
                emailReadiness: 'VALID',
                permissionState: 'UNKNOWN',
                ...timestamps,
              },
            })
            const sourceId = `SYN-OUTREACH-SOURCE-${suffix}`
            await tx.prospectSourceEvidence.create({
              data: {
                id: sourceId,
                organizationId,
                venueId,
                sourceType: 'SYNTHETIC_ACCEPTANCE_ONLY',
                sourceUrl,
                sourceLabel: 'Fictional source; never contacted or researched',
                capturedValue: { synthetic: true },
                createdBy: fixtureActor,
              },
            })
            await tx.prospectVenueIntelligence.create({
              data: {
                venueId,
                identityKey: venueId,
                rankingVersion: 'synthetic-only',
                fields: {
                  estimatedSize: { value: 'small', status: 'verified', sourceUrls: [sourceUrl] },
                },
                contactClaims: [
                  {
                    channel: 'email',
                    value: email,
                    status: 'verified-public-claim',
                    sourceUrls: [sourceUrl],
                  },
                ],
              },
            })
            await tx.prospectVenueGeography.create({
              data: {
                venueId,
                modelVersion,
                countyGeoid: '17031',
                territoryId,
                status: 'ASSIGNED',
                reason: 'EXPLICIT SYNTHETIC FIXTURE. Not a researched physical location.',
                evidenceIds: [sourceId],
                ...timestamps,
              },
            })
            selections.push({ venueId, contactId })
          }
          await tx.prospectOrganization.create({
            data: {
              id: 'SYN-TOMS-TEST-ORG',
              canonicalName: "Tom's Test Venue",
              normalizedName: "tom's test venue",
              source: 'PRIVATE_SELF_TEST_FIXTURE_ONLY',
              territoryId,
              ...timestamps,
            },
          })
          await tx.prospectVenue.create({
            data: {
              id: 'SYN-TOMS-TEST-VENUE',
              organizationId: 'SYN-TOMS-TEST-ORG',
              name: "Tom's Test Venue",
              normalizedName: "tom's test venue",
              notes:
                'No owned recipient confirmed. No external recipient, routing claim, approval or delivery enabled.',
              ...timestamps,
            },
          })
          checks.push(
            '106 synthetic venues seeded only in the empty acceptance database; Tom test inbox remains unconfirmed',
          )
          const client = new Proxy(tx, {
            get(object, key) {
              return key === '$transaction'
                ? async (callback: (connection: typeof tx) => unknown) => callback(tx)
                : Reflect.get(object, key)
            },
          })
          const taskIds = new Map<string, string>(),
            prepIds = new Map<string, string>()
          let clock = new Date('2026-09-23T19:00:00Z')
          const readView = async (venueId: string) => {
            const live = await readNativeSalesSnapshot(venueId, tx)
            const head = await tx.prospectOutreachDraft.findFirst({
              where: { venueId },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            })
            return {
              venueId,
              organizationId: live.organization.id,
              name: live.venue.name,
              snapshotHash: live.snapshotHash,
              sourceState: 'EXPLICIT_SYNTHETIC_ACCEPTANCE_PROJECTION',
              sourceCount: live.sources.length,
              routing: { value: live.contacts[0]?.normalizedEmail ?? null, kind: 'email' },
              suppression: live.suppression,
              threadCandidates: [],
              writerHold: null,
              blocker: null,
              outreachState: head ? 'DRAFT_REVIEW' : 'UNPREPARED',
              correspondenceState: 'NO_RETAINED_HISTORY',
              preparation: taskIds.has(venueId) ? { id: prepIds.get(venueId), stale: false } : null,
              writerTask: taskIds.has(venueId)
                ? {
                    taskId: taskIds.get(venueId),
                    binding: { recipient: live.contacts[0]!.normalizedEmail },
                  }
                : null,
              draft: head
                ? {
                    id: head.id,
                    version: head.version,
                    contentHash: head.contentHash,
                    subject: head.subject,
                    body: head.textBody,
                    state: 'DRAFT_REVIEW',
                    writerAttribution: null,
                  }
                : null,
              operational: null,
              SEND_AUTHORIZED: false,
            } as any
          }
          const service = createOutreachCohortService({
            client: client as any,
            readView,
            now: () => clock,
          })
          const actor = {
            id: fixtureActor,
            type: 'HUMAN' as const,
            runId: 'synthetic-run',
            scope: { mode: 'ALL' as const },
            capabilities: ['prospects.read', 'prospects.correspondence.read', 'prospects.maintain'],
          }
          const previewInput = {
            question: 'Prepare up to 50 synthetic small Chicago and Evanston museums; no send.',
            candidates: selections,
            count: 50,
            excludePriorGroups: true as const,
          }
          const preview = await service.preview(previewInput, actor)
          assert.equal(preview.selectedCount, 50)
          assert.equal(preview.heldCount, 0)
          const reserveInput = {
            requestKey: 'synthetic-first-50',
            name: 'Synthetic cohort 1 / no send',
            preview: previewInput,
            expectedPreviewHash: preview.previewHash,
          }
          const first = await service.reserve(reserveInput, actor)
          assert.equal(first.count, 50)
          assert.equal((await service.reserve(reserveInput, actor)).replayed, true)
          await assert.rejects(
            service.reserve({ ...reserveInput, name: 'Changed behind same key' }, actor),
          )
          checks.push(
            'native cohort create/reopen/request-key replay; changed-payload replay rejected',
          )
          const windowInput = {
            cohortId: first.cohortId,
            requestKey: 'window-1',
            limit: 5,
            leaseSeconds: 600,
          }
          const window = (await service.claimWindow(windowInput, actor)) as any
          const replay = (await service.claimWindow(windowInput, actor)) as any
          assert.equal(window.claims.length, 5)
          assert.deepEqual(replay.claims, window.claims)
          assert.equal(replay.replayed, true)
          checks.push(
            'native five-record lease and lost-window-response replay return the same exact members/tokens',
          )
          const member = window.claims[0]
          taskIds.set(member.venueId, 'synthetic-writer-task')
          prepIds.set(member.venueId, 'synthetic-preparation')
          await service.checkpoint(
            {
              action: 'prepared',
              cohortId: first.cohortId,
              memberId: member.memberId,
              leaseToken: member.lease.token,
              taskId: 'synthetic-writer-task',
              preparationId: 'synthetic-preparation',
            },
            actor,
          )
          // Explicit fixture draft/receipt, not a claim of 50 actual Codex outputs.
          const draftId = 'SYN-OUTREACH-REVIEW-DRAFT',
            contentHash = cohortHash(['Synthetic original subject', 'Synthetic original body']),
            receiptId = 'SYN-OUTREACH-WRITER-RECEIPT'
          await tx.prospectOutreachDraft.create({
            data: {
              id: draftId,
              organizationId: member.organizationId,
              venueId: member.venueId,
              contactId: member.contactId,
              preparationKey: cohortHash('synthetic-preparation'),
              version: 1,
              toEmail: member.recipient,
              subject: 'Synthetic original subject',
              textBody: 'Synthetic original body',
              contentHash,
              groundingSnapshot: {
                schema: 'torchiko.native-sales-draft/1',
                SEND_AUTHORIZED: false,
                synthetic: true,
                noActualModelClaim: true,
              },
              generatedByType: 'SYSTEM',
              generatedById: fixtureActor,
            },
          })
          await tx.prospectActivity.create({
            data: {
              id: receiptId,
              organizationId: member.organizationId,
              venueId: member.venueId,
              type: 'OUTREACH_DRAFTED',
              summary: 'Synthetic writer receipt fixture only',
              actorId: fixtureActor,
              evidence: {
                schema: 'torchiko.native-writer-import/1',
                taskId: 'synthetic-writer-task',
                draftId,
                fixtureOnly: true,
              },
            },
          })
          const imported = {
            action: 'imported' as const,
            cohortId: first.cohortId,
            memberId: member.memberId,
            leaseToken: member.lease.token,
            receiptId,
            draftId,
          }
          await assert.rejects(service.checkpoint({ ...imported, receiptId: 'forged' }, actor))
          await service.checkpoint(imported, actor)
          assert.equal((await service.checkpoint(imported, actor)).replayed, true)
          const review = await service.read({ cohortId: first.cohortId }, actor)
          assert.equal(review.count, 50)
          assert.equal(review.rows.length, 50)
          assert.equal(review.rows[0]!.draft?.body, 'Synthetic original body')
          assert.equal(review.readyForHumanReview, 1)
          const acknowledgement = {
            cohortId: first.cohortId,
            expectedReviewHash: review.reviewHash,
            expectedCount: 50,
            acknowledgement:
              'I reviewed these exact messages and holds. This is not sending approval.' as const,
          }
          await assert.rejects(service.acknowledge(acknowledgement, { ...actor, type: 'AGENT' }))
          await assert.rejects(
            service.acknowledge({ ...acknowledgement, expectedReviewHash: '0'.repeat(64) }, actor),
          )
          const ack = await service.acknowledge(acknowledgement, actor)
          assert.equal(ack.sendApprovalCreated, false)
          assert.equal((await service.acknowledge(acknowledgement, actor)).replayed, true)
          checks.push(
            'exact 50-row review includes draft text/hash and every unfinished row; forged receipt, stale review and agent acknowledgement rejected',
          )
          const nextPreview = await service.preview(previewInput, actor)
          assert.equal(nextPreview.selectedCount, 50)
          assert.equal(nextPreview.excludedCount, 50)
          assert.ok(
            nextPreview.rows
              .filter((r) => r.selected)
              .every((r) => Number(r.venueId.slice(-3)) > 50),
          )
          const next = await service.reserve(
            {
              ...reserveInput,
              requestKey: 'synthetic-next-50',
              name: 'Synthetic cohort 2 / no send',
              expectedPreviewHash: nextPreview.previewHash,
            },
            actor,
          )
          assert.equal(next.count, 50)
          const last = await service.preview(previewInput, actor)
          assert.equal(last.selectedCount, 5)
          assert.equal(last.shortfall, 45)
          checks.push(
            'second group excludes all first 50; third request reports only five remaining, not invented quota fillers',
          )
          clock = new Date('2026-09-23T19:11:00Z')
          await service.claimWindow({ ...windowInput, requestKey: 'expired-window-check' }, actor)
          const afterExpiry = await service.read({ cohortId: first.cohortId }, actor)
          assert.ok(
            afterExpiry.rows.filter((r) => r.state === 'IMPORT_RECOVERY_REQUIRED').length >= 4,
          )
          await assert.rejects(
            service.read(
              { cohortId: first.cohortId },
              { ...actor, scope: { mode: 'TERRITORIES', territoryIds: ['not-granted'] } },
            ),
          )
          await assert.rejects(
            service.read(
              { cohortId: first.cohortId },
              { ...actor, capabilities: ['prospects.read'] },
            ),
          )
          checks.push(
            'expired leases become recovery holds; entire-cohort territory and correspondence access enforced',
          )
          const activities = await tx.prospectActivity.findMany({
            where: { organizationId: member.organizationId },
          })
          for (const activity of activities)
            assert.ok(
              !JSON.stringify(activity.evidence).includes('fixture-002@example.invalid'),
              'Individual activity leaked another recipient',
            )
          assert.equal(await tx.prospectSendBatch.count(), 0)
          assert.equal(await tx.prospectSendItem.count(), 0)
          assert.equal(await tx.correspondenceProviderAccount.count(), 0)
          assert.equal(
            await tx.prospectOutreachDraft.count({ where: { approvedAt: { not: null } } }),
            0,
          )
          checks.push(
            'aggregate privacy preserved; zero send batches/items/provider accounts/approved drafts',
          )
          return {
            schema: 'torchiko.outreach-native-cohort-acceptance/1',
            passed: true,
            target,
            transaction: 'Serializable native PostgreSQL; suite rolls back on any failed assertion',
            checks,
            firstCohortId: first.cohortId,
            secondCohortId: next.cohortId,
            firstReview: review,
            acknowledgement: ack,
            syntheticWriterProjection: true,
            modelGenerationClaim:
              'See separate NATIVE-CODEX-PROOF.json; this batch test does not claim fifty Codex generations.',
            tomTestVenue: {
              id: 'SYN-TOMS-TEST-VENUE',
              name: "Tom's Test Venue",
              recipient: null,
              state: 'OWNED_INBOX_CONFIRMATION_REQUIRED',
            },
            realProspectRowsCopied: 0,
            SEND_AUTHORIZED: false,
          }
        },
        { isolationLevel: 'Serializable', timeout: 90000, maxWait: 10000 },
      ),
    )
    await writeFile(
      path.resolve(__dirname, '../../qa/NATIVE-COHORT-PROOF.json'),
      JSON.stringify(proof, null, 2),
      { flag: 'wx' },
    )
    console.log(
      JSON.stringify({
        passed: true,
        checks: proof.checks,
        firstCohortId: proof.firstCohortId,
        secondCohortId: proof.secondCohortId,
        SEND_AUTHORIZED: false,
      }),
    )
  } finally {
    await db.$disconnect()
  }
}
void main().catch((error) => {
  console.error(error.stack)
  process.exitCode = 1
})
