import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { createProspectAction } from './prospect-actions'
import { reviewProspectContactReadinessAction } from './prospect-contactability-actions'
import {
  createProspectCampaignAction,
  saveProspectOutreachDraftAction,
} from './prospect-outreach-actions'

const enabled =
  process.env.RUN_PROSPECT_OUTREACH_SOURCE_EVIDENCE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('prospect source evidence draft disposable readback', () => {
  afterAll(async () => db.$disconnect())

  it('stores transaction-resolved, scoped source fields and digest in the saved draft', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `source-evidence-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const prospect = await createProspectAction({
        organization: {
          canonicalName: `Source Evidence Museum ${suffix}`,
          source: 'disposable-source-evidence-test',
        },
        venue: {
          name: `Source Evidence Museum ${suffix}`,
          city: 'Chicago',
          region: 'IL',
        },
        contact: {
          fullName: 'Avery Example',
          email: `source-evidence-${suffix}@example.test`,
          source: 'disposable-source-evidence-test',
        },
        actor,
      })
      if (!prospect.venue || !prospect.contact)
        throw new Error('Disposable prospect fixture requires a venue and contact')

      await reviewProspectContactReadinessAction({
        contactId: prospect.contact.id,
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        evidence: {
          reviewReason: 'Disposable source evidence fixture for draft persistence verification.',
          source: 'disposable-source-evidence-test',
          reviewedFor: 'draft-only',
        },
        actor,
      })
      const campaign = await createProspectCampaignAction({
        name: `Source Evidence Campaign ${suffix}`,
        organizationIds: [prospect.organization.id],
        cohortSnapshot: { source: 'disposable-source-evidence-test' },
        actor,
      })
      const member = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId: campaign.id, organizationId: prospect.organization.id },
        select: { id: true },
      })
      const capturedAt = new Date('2026-09-24T12:00:00.000Z')
      const source = await db.prospectSourceEvidence.create({
        data: {
          organizationId: prospect.organization.id,
          venueId: prospect.venue.id,
          contactId: prospect.contact.id,
          sourceType: 'WEBSITE',
          sourceUrl: 'https://example.test/about',
          sourceLabel: 'About page',
          capturedValue: { email: prospect.contact.email },
          researchedAt: capturedAt,
          createdBy: actor.id,
        },
        select: { id: true },
      })

      const draft = await saveProspectOutreachDraftAction({
        memberId: member.id,
        subject: 'A review-only introduction',
        textBody: 'A factual draft kept for human review.',
        sourceEvidenceIds: [source.id],
        groundingSnapshot: {
          resolvedSourceEvidence: [{ id: source.id, sourceUrl: 'https://attacker.invalid' }],
        },
        actor: {
          type: 'AGENT',
          id: `agent-${suffix}`,
          capabilities: ['prospects:read', 'prospects:draft'],
        },
      })

      const readback = await db.prospectOutreachDraft.findUniqueOrThrow({
        where: { id: draft.id },
        select: { id: true, status: true, groundingSnapshot: true, contentHash: true },
      })
      const snapshot = readback.groundingSnapshot as {
        resolvedSourceEvidence: Array<Record<string, unknown>>
      }
      const expectedFields = {
        id: source.id,
        organizationId: prospect.organization.id,
        venueId: prospect.venue.id,
        contactId: prospect.contact.id,
        sourceType: 'WEBSITE',
        sourceUrl: 'https://example.test/about',
        sourceLabel: 'About page',
        capturedValue: { email: prospect.contact.email },
        importRowId: null,
        researchedAt: capturedAt.toISOString(),
        createdBy: actor.id,
        createdAt: (
          await db.prospectSourceEvidence.findUniqueOrThrow({
            where: { id: source.id },
            select: { createdAt: true },
          })
        ).createdAt.toISOString(),
      }

      expect(readback).toMatchObject({ id: draft.id, status: 'NEEDS_REVIEW' })
      expect(snapshot.resolvedSourceEvidence).toEqual([
        {
          ...expectedFields,
          sha256: createHash('sha256').update(JSON.stringify(expectedFields)).digest('hex'),
        },
      ])
      expect(snapshot.resolvedSourceEvidence[0]?.sourceUrl).not.toBe('https://attacker.invalid')
      expect(readback.contentHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(await db.prospectSendBatch.count({ where: { campaignId: campaign.id } })).toBe(0)
    })
  })
})
