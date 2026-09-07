import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  db,
  withTenantIsolationBypass,
  getIntakeSubmissionDraft,
  saveIntakeSubmissionDraft,
  createIntakeProposal,
} from '@pathfinder/db'
import { retrieveGuestKnowledge } from './guest-knowledge-retrieval'
import { runGuestRetrievalBaseline } from './evaluation/guest-retrieval-baseline'

const enabled =
  process.env.RUN_V2_CUSTOMER_JOURNEY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('V2 customer journey on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('preserves concurrent drafts, rolls back stale submissions, and retrieves scoped long-tail facts without embeddings', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `journey-${suffix}`
      const venueId = `museum-${suffix}`
      const ownerUserId = `owner-${suffix}`
      const otherTenantId = `other-${suffix}`
      const otherVenueId = `other-museum-${suffix}`
      await db.tenant.createMany({
        data: [tenantId, otherTenantId].map((id) => ({ id, slug: id, name: 'Synthetic journey' })),
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, slug: venueId, name: 'Synthetic museum' },
          {
            id: otherVenueId,
            tenantId: otherTenantId,
            slug: otherVenueId,
            name: 'Other synthetic museum',
          },
        ],
      })
      await db.user.create({ data: { id: ownerUserId, email: `${ownerUserId}@example.test` } })
      const scope = { tenantId, venueId, ownerUserId, sourceKind: 'NOTES' as const }
      const save = (notes: string, expectedRevision: number) =>
        saveIntakeSubmissionDraft({
          ...scope,
          expectedRevision,
          content: { kind: 'NOTES', notes },
        })
      const firstSaves = await Promise.allSettled([save('First tab', 0), save('Second tab', 0)])
      expect(firstSaves.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      expect(firstSaves.find((item) => item.status === 'rejected')).toMatchObject({
        reason: { code: 'CONFLICT' },
      })
      const original = await getIntakeSubmissionDraft(scope)
      expect(original?.revision).toBe(1)
      expect(await getIntakeSubmissionDraft({ ...scope, ownerUserId: 'not-the-owner' })).toBeNull()
      expect(await getIntakeSubmissionDraft({ ...scope, tenantId: otherTenantId })).toBeNull()
      const nextSaves = await Promise.allSettled([
        save('North gallery capacity is 137.', 1),
        save('Stale second tab', 1),
      ])
      expect(nextSaves.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      const saved = await getIntakeSubmissionDraft(scope)
      expect(saved?.revision).toBe(2)
      const actor = { type: 'HUMAN' as const, id: ownerUserId, role: 'OWNER' as const }
      const staleRequestId = randomUUID()
      await expect(
        createIntakeProposal({
          db,
          tenantId,
          venueId,
          actor,
          requestId: staleRequestId,
          proposal: { kind: 'NOTES', notes: 'Stale submission must not create a proposal.' },
          draft: { ownerUserId, expectedRevision: 1 },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await db.intakeRun.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.intakeEvidenceRecord.count({ where: { tenantId, venueId } })).toBe(0)
      const requestId = randomUUID()
      const proposal = {
        kind: 'NOTES' as const,
        notes: (saved!.content as { notes: string }).notes,
      }
      const submit = () =>
        createIntakeProposal({
          db,
          tenantId,
          venueId,
          actor,
          requestId,
          proposal,
          draft: { ownerUserId, expectedRevision: 2 },
        })
      const submitted = await submit()
      expect((await submit()).id).toBe(submitted.id)
      expect(await db.intakeRun.count({ where: { tenantId, venueId } })).toBe(1)
      expect(await getIntakeSubmissionDraft(scope)).toMatchObject({
        submittedProposalId: submitted.id,
        revision: 3,
      })
      await save('A fresh post-submission note', 0)
      expect(await getIntakeSubmissionDraft(scope)).toMatchObject({
        submittedProposalId: null,
        revision: 4,
      })

      const older = new Date('2025-01-01T00:00:00Z')
      await db.venueKnowledgeEntry.createMany({
        data: [
          ...Array.from({ length: 95 }, (_, index) => ({
            id: `distractor-${suffix}-${index}`,
            tenantId,
            venueId,
            title: `Museum gallery ${index}`,
            category: 'Visit',
            content: 'Gallery visitors can see paintings. Capacity varies by event.',
            lastReviewedAt: new Date(),
          })),
          {
            id: `capacity-${suffix}`,
            tenantId,
            venueId,
            title: 'North gallery capacity',
            category: 'Approved facts',
            content: `${'The museum displays regional art. '.repeat(400)}North gallery maximum capacity is exactly 137 visitors.`,
            lastReviewedAt: older,
          },
          {
            id: `capacity-archived-${suffix}`,
            tenantId,
            venueId,
            title: 'Archived obsolete north gallery capacity occupancy visitors guests',
            category: 'Superseded schedule',
            content: 'The old maximum capacity was 120 visitors.',
            lastReviewedAt: new Date(),
          },
          {
            id: `private-${suffix}`,
            tenantId,
            venueId,
            title: 'North gallery capacity private',
            category: 'Staff',
            content: 'Private staff planning limit is 999.',
            visibility: 'SECOND_LAYER',
            lastReviewedAt: new Date(),
          },
          {
            id: `cross-${suffix}`,
            tenantId: otherTenantId,
            venueId: otherVenueId,
            title: 'North gallery capacity',
            category: 'Visit',
            content: 'Other tenant capacity is 888.',
            lastReviewedAt: new Date(),
          },
          {
            id: `disabled-${suffix}`,
            tenantId,
            venueId,
            title: 'North gallery capacity disabled',
            category: 'Visit',
            content: 'Old disabled capacity is 777.',
            isEnabled: false,
            lastReviewedAt: new Date(),
          },
        ].map((entry) => ({
          ...entry,
          lastReviewedBy: ownerUserId,
          sourceType: 'SYNTHETIC_FIXTURE',
          authorship: 'HUMAN_AUTHORED',
        })),
      })
      for (const query of [
        'What is the north gallery capacity?',
        '¿Cuántas personas caben en la galería norte?',
      ]) {
        const result = await retrieveGuestKnowledge({
          reader: db,
          query,
          tenantId,
          venueId,
          includeSecondLayer: false,
          queryEmbedding: null,
        })
        expect(result.entries.map((entry) => entry.id)).toContain(`capacity-${suffix}`)
        expect(result.entries.map((entry) => entry.id)).not.toEqual(
          expect.arrayContaining([`private-${suffix}`, `cross-${suffix}`, `disabled-${suffix}`]),
        )
        expect(result.entries.map((entry) => entry.id)).toContain(`capacity-archived-${suffix}`)
        expect(result.trace.truncatedSourceIds).toContain(`capacity-${suffix}`)
        const retrievedContent = result.entries.map((entry) => entry.content).join('\n')
        expect(retrievedContent).not.toMatch(/999|888|777/)
        expect(retrievedContent).toContain('120 visitors')
        expect(result.trace.path).toBe('lexical-fallback')
        expect(
          result.trace.retrievedSources.find((entry) => entry.id === `capacity-${suffix}`)?.version,
        ).toMatch(/^\d{4}-/)
      }
      const baseline = await runGuestRetrievalBaseline({
        reader: {
          venueKnowledgeEntry: {
            findMany: (args) => db.venueKnowledgeEntry.findMany(args as never),
          },
        },
        tenantId,
        venueId,
        intendedTestTargetMs: 5_000,
        cases: [
          {
            name: 'english-long-tail-capacity-no-embedding',
            query: 'What is the north gallery capacity?',
            expectedSourceId: `capacity-${suffix}`,
          },
          {
            name: 'spanish-long-tail-capacity-no-embedding',
            query: '¿Cuántas personas caben en la galería norte?',
            expectedSourceId: `capacity-${suffix}`,
          },
        ],
      })
      expect(baseline.comparison).toEqual({
        allExpectedSourcesFound: true,
        allWithinIntendedTestTarget: true,
      })
      expect(baseline.provider).toMatchObject({
        called: false,
        latencyMs: null,
        invoiceCostUsd: null,
      })
      // Disposable proof output is intentionally machine-readable for release evidence.
      // eslint-disable-next-line no-console
      console.info(JSON.stringify({ event: 'guest-retrieval-baseline', ...baseline }))
    })
  }, 60_000)
})
