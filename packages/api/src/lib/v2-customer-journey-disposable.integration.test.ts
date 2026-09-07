import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  db,
  withTenantIsolationBypass,
  getIntakeSubmissionDraft,
  saveIntakeSubmissionDraft,
  createIntakeProposal,
  createUniversalContentAction,
  addUniversalContentRevisionAction,
  publishUniversalContentAction,
  searchKnowledgeByEmbedding,
  withdrawUniversalContentAction,
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

      const publicationActor = {
        type: 'HUMAN' as const,
        id: ownerUserId,
        role: 'PLATFORM_ADMIN' as const,
      }
      const published: Array<{ moduleId: string; revisionId: string; publicationId: string }> = []
      for (let index = 0; index < 55; index += 1) {
        const moduleId = randomUUID()
        const created = await createUniversalContentAction({
          db,
          tenantId,
          venueId,
          moduleId,
          actor: publicationActor,
          draft: {
            audience: 'PUBLIC',
            evidence: [],
            payload: {
              kind: 'POLICY',
              title: index === 54 ? 'Quasar stroller storage policy' : `Universal policy ${index}`,
              rule:
                index === 54
                  ? 'Quasar strollers must be stored beside the east welcome desk.'
                  : `Fixture policy value ${index}.`,
              appliesTo: [],
            },
          },
        })
        const publication = await publishUniversalContentAction({
          db,
          tenantId,
          venueId,
          moduleId: created.moduleId,
          revisionId: created.revisionId,
          expectedLatestVersion: 1,
          requestId: randomUUID(),
          actor: publicationActor,
        })
        published.push({ ...created, publicationId: publication.publicationId })
      }
      const projection = await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { tenantId, venueId, contentModuleId: published[54]!.moduleId },
        select: {
          id: true,
          contentModuleId: true,
          contentRevisionId: true,
          contentPublicationId: true,
          isEnabled: true,
        },
      })
      expect(projection).toMatchObject({
        contentModuleId: published[54]!.moduleId,
        contentRevisionId: published[54]!.revisionId,
        contentPublicationId: published[54]!.publicationId,
        isEnabled: true,
      })
      expect(
        await db.venueKnowledgeEntry.findUniqueOrThrow({
          where: { id: projection.id },
          select: { authorship: true },
        }),
      ).toEqual({ authorship: 'UNKNOWN' })
      const backfillTarget = published[0]!
      await db.$executeRaw`SELECT sync_universal_content_search_projection(${backfillTarget.publicationId})`
      await expect(
        db.venueKnowledgeEntry.findFirst({
          where: { tenantId, venueId, contentModuleId: backfillTarget.moduleId },
        }),
      ).resolves.toMatchObject({ contentRevisionId: backfillTarget.revisionId, isEnabled: true })

      await expect(
        db.$executeRaw`
          INSERT INTO venue_knowledge_entries (
            id, tenant_id, venue_id, title, category, content, is_enabled, visibility,
            source_type, authorship, content_module_id, content_revision_id,
            content_publication_id, created_at, updated_at
          ) VALUES (
            ${`bad_${randomUUID()}`}, ${tenantId}, ${venueId}, 'invalid', 'POLICY', 'invalid',
            TRUE, 'PUBLIC', 'UNIVERSAL_CONTENT', 'UNKNOWN', ${published[0]!.moduleId},
            ${published[1]!.revisionId}, ${published[0]!.publicationId}, NOW(), NOW()
          )
        `,
      ).rejects.toThrow()
      await expect(
        db.venueKnowledgeEntry.update({
          where: { id: projection.id },
          data: { content: 'independently edited projection' },
        }),
      ).rejects.toThrow()
      await expect(
        db.venueKnowledgeEntry.delete({ where: { id: projection.id } }),
      ).rejects.toThrow()

      const relationship = await createUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: randomUUID(),
        actor: publicationActor,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'RELATIONSHIP',
            fromModuleId: published[0]!.moduleId,
            toModuleId: published[1]!.moduleId,
            relationshipType: 'RELATED_TO',
            description: 'Internal graph linkage must not become guest free text.',
          },
        },
      })
      const relationshipPublication = await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: relationship.moduleId,
        revisionId: relationship.revisionId,
        expectedLatestVersion: 1,
        requestId: randomUUID(),
        actor: publicationActor,
      })
      await expect(
        db.venueKnowledgeEntry.findFirst({
          where: { tenantId, venueId, contentModuleId: relationship.moduleId },
        }),
      ).resolves.toBeNull()
      await expect(
        db.$executeRaw`
          INSERT INTO venue_knowledge_entries (
            id, tenant_id, venue_id, title, category, content, is_enabled, visibility,
            source_type, authorship, content_module_id, content_revision_id,
            content_publication_id, created_at, updated_at
          ) VALUES (
            ${`invented_${randomUUID()}`}, ${tenantId}, ${venueId}, 'Invented relationship',
            'RELATIONSHIP', 'Private endpoint identifiers', TRUE, 'PUBLIC',
            'UNIVERSAL_CONTENT', 'UNKNOWN', ${relationship.moduleId}, ${relationship.revisionId},
            ${relationshipPublication.publicationId}, NOW(), NOW()
          )
        `,
      ).rejects.toThrow(/current publication ledger event/)
      const projectedRetrieval = await retrieveGuestKnowledge({
        reader: db,
        query: 'Where must Quasar strollers be stored?',
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: null,
      })
      expect(projectedRetrieval.entries.map((entry) => entry.id)).toContain(projection.id)
      expect(
        projectedRetrieval.entries.find((entry) => entry.id === projection.id)?.content,
      ).toContain('east welcome desk')
      expect(projectedRetrieval.trace.publicationAuthority).toContainEqual(
        expect.objectContaining({
          id: projection.id,
          moduleId: published[54]!.moduleId,
          revisionId: published[54]!.revisionId,
          publicationId: published[54]!.publicationId,
        }),
      )
      const futureModuleId = randomUUID()
      const future = await createUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: futureModuleId,
        actor: publicationActor,
        draft: {
          audience: 'PUBLIC',
          effectiveFrom: '2035-01-01T00:00:00.000Z',
          effectiveUntil: '2036-01-01T00:00:00.000Z',
          evidence: [],
          payload: {
            kind: 'POLICY',
            title: 'Nebula ticket exchange',
            rule: 'Nebula tickets exchange at the south desk.',
            appliesTo: [],
          },
        },
      })
      await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: future.moduleId,
        revisionId: future.revisionId,
        expectedLatestVersion: 1,
        requestId: randomUUID(),
        actor: publicationActor,
      })
      const retrieveNebula = (asOf: Date) =>
        retrieveGuestKnowledge({
          reader: db,
          query: 'Where can Nebula tickets be exchanged?',
          tenantId,
          venueId,
          includeSecondLayer: false,
          queryEmbedding: null,
          asOf,
        })
      await expect(retrieveNebula(new Date('2034-12-31T23:59:59.999Z'))).resolves.toMatchObject({
        entries: [],
      })
      expect(
        (await retrieveNebula(new Date('2035-06-01T00:00:00.000Z'))).entries.map(
          (entry) => entry.contentModuleId,
        ),
      ).toContain(future.moduleId)
      await expect(retrieveNebula(new Date('2036-01-01T00:00:00.000Z'))).resolves.toMatchObject({
        entries: [],
      })
      await withdrawUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: published[54]!.moduleId,
        expectedPublishedRevisionId: published[54]!.revisionId,
        requestId: randomUUID(),
        actor: publicationActor,
      })
      expect(
        await retrieveGuestKnowledge({
          reader: db,
          query: 'Where must Quasar strollers be stored?',
          tenantId,
          venueId,
          includeSecondLayer: false,
          queryEmbedding: null,
        }),
      ).toMatchObject({
        trace: { retrievedSourceIds: expect.not.arrayContaining([projection.id]) },
      })

      const vector = `[${Array.from({ length: 1_536 }, () => 0.01).join(',')}]`
      await db.$executeRaw`
        UPDATE venue_knowledge_entries
           SET embedding = ${vector}::vector
         WHERE id = ${projection.id} AND tenant_id = ${tenantId}
      `
      await expect(
        searchKnowledgeByEmbedding({
          queryEmbedding: Array.from({ length: 1_536 }, () => 0.01),
          tenantId,
          venueId,
          includeSecondLayer: false,
        }),
      ).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: projection.id })]),
      )

      const versionedProjection = await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { tenantId, venueId, contentModuleId: published[2]!.moduleId },
      })
      await db.$executeRaw`
        UPDATE venue_knowledge_entries
           SET embedding = ${vector}::vector
         WHERE id = ${versionedProjection.id} AND tenant_id = ${tenantId}
      `
      const secondRevision = await addUniversalContentRevisionAction({
        db,
        tenantId,
        venueId,
        moduleId: published[2]!.moduleId,
        expectedLatestVersion: 1,
        actor: publicationActor,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'POLICY',
            title: 'Universal policy 2 replacement',
            rule: 'The newly published revision requires a new embedding.',
            appliesTo: [],
          },
        },
      })
      const secondPublication = await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: secondRevision.moduleId,
        revisionId: secondRevision.revisionId,
        expectedLatestVersion: 2,
        requestId: randomUUID(),
        actor: publicationActor,
      })
      await expect(
        db.$queryRaw<Array<{ content_revision_id: string; embedding_is_null: boolean }>>`
          SELECT content_revision_id, embedding IS NULL AS embedding_is_null
            FROM venue_knowledge_entries
           WHERE id = ${versionedProjection.id} AND tenant_id = ${tenantId}
        `,
      ).resolves.toEqual([
        { content_revision_id: secondRevision.revisionId, embedding_is_null: true },
      ])
      await db.$executeRaw`
        UPDATE venue_knowledge_entries SET embedding = ${vector}::vector
         WHERE id = ${versionedProjection.id} AND tenant_id = ${tenantId}
      `
      await db.embeddingDispatch.deleteMany({
        where: {
          tenantId,
          venueId,
          entityType: 'KNOWLEDGE_ENTRY',
          entityId: versionedProjection.id,
        },
      })
      const beforeReplay = await db.venueKnowledgeEntry.findUniqueOrThrow({
        where: { id: versionedProjection.id },
        select: { updatedAt: true },
      })
      await db.$executeRaw`SELECT sync_universal_content_search_projection(${secondPublication.publicationId})`
      await expect(
        db.$queryRaw<Array<{ updated_at: Date; embedding_is_null: boolean }>>`
          SELECT updated_at, embedding IS NULL AS embedding_is_null
            FROM venue_knowledge_entries
           WHERE id = ${versionedProjection.id} AND tenant_id = ${tenantId}
        `,
      ).resolves.toEqual([{ updated_at: beforeReplay.updatedAt, embedding_is_null: false }])
      await expect(
        db.embeddingDispatch.count({
          where: {
            tenantId,
            venueId,
            entityType: 'KNOWLEDGE_ENTRY',
            entityId: versionedProjection.id,
          },
        }),
      ).resolves.toBe(0)

      const thirdRevision = await addUniversalContentRevisionAction({
        db,
        tenantId,
        venueId,
        moduleId: published[2]!.moduleId,
        expectedLatestVersion: 2,
        actor: publicationActor,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'POLICY',
            title: 'Universal policy 2 replacement',
            rule: 'The newly published revision requires a new embedding.',
            appliesTo: [],
          },
        },
      })
      await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: thirdRevision.moduleId,
        revisionId: thirdRevision.revisionId,
        expectedLatestVersion: 3,
        requestId: randomUUID(),
        actor: publicationActor,
      })
      await expect(
        db.$queryRaw<Array<{ embedding_is_null: boolean }>>`
          SELECT embedding IS NULL AS embedding_is_null FROM venue_knowledge_entries
           WHERE id = ${versionedProjection.id} AND tenant_id = ${tenantId}
        `,
      ).resolves.toEqual([{ embedding_is_null: true }])
      await expect(
        db.embeddingDispatch.count({
          where: {
            tenantId,
            venueId,
            entityType: 'KNOWLEDGE_ENTRY',
            entityId: versionedProjection.id,
          },
        }),
      ).resolves.toBe(1)
    })
  }, 60_000)
})
