/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OPERATOR_MCP_OUTPUTS, OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import type { VerifiedOperatorGrant } from '../oauth'
import { createOperatorRegistry, defaultVenueRead } from '../registry'

/**
 * crm.get_outreach_context on a real disposable PostgreSQL. Invented names and example domains
 * only. Runs only against a database named pathfinder_disposable_*.
 */
const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

const resolution = resolveOperatorConfig({
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
  OPERATOR_OAUTH_PEPPERS: `k1:${randomBytes(32).toString('base64url')}`,
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_owner',
  RAILWAY_ENVIRONMENT: 'staging',
})
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const tenantA = `outreach-a-${suffix}`
const tenantB = `outreach-b-${suffix}`
const NOW = new Date('2026-10-02T12:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)

function grant(
  tenantIds: string[] = [tenantA],
  capabilities: string[] = [...OperatorCapability.options],
): VerifiedOperatorGrant {
  return {
    grantId: `grant-${suffix}`,
    clientId: 'client-example',
    userId: 'user_owner',
    allTenants: false,
    tenantIds,
    capabilities: capabilities as never,
  }
}

const registry = createOperatorRegistry()
async function call(args: Record<string, unknown>, operatorGrant = grant()) {
  const output = await registry.callTool('crm.get_outreach_context', args, {
    config,
    database: db,
    grant: operatorGrant,
    now: NOW,
    requestId: randomUUID(),
    venueRead: defaultVenueRead(db),
  })
  return OPERATOR_MCP_OUTPUTS['crm.get_outreach_context'].parse(output) as any
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()

async function makeOrg(name: string, stage = 'RESEARCHED', extra: Record<string, unknown> = {}) {
  return db.prospectOrganization.create({
    data: {
      canonicalName: name,
      normalizedName: slug(name),
      headquartersCity: 'Springfield',
      headquartersRegion: 'IL',
      createdBy: 'seed',
      updatedBy: 'seed',
      opportunity: { create: { stage: stage as never, createdBy: 'seed', updatedBy: 'seed' } },
      ...extra,
    } as never,
  })
}

async function makeVenue(
  organizationId: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return db.prospectVenue.create({
    data: {
      organizationId,
      name,
      normalizedName: slug(name),
      city: 'Springfield',
      region: 'IL',
      createdBy: 'seed',
      updatedBy: 'seed',
      ...extra,
    } as never,
  })
}

async function makeContact(
  organizationId: string,
  id: string,
  email: string | null,
  extra: Record<string, unknown> = {},
) {
  return db.prospectContact.create({
    data: {
      id,
      organizationId,
      fullName: `Person ${id}`,
      title: 'Director',
      email,
      normalizedEmail: email,
      emailReadiness: 'VALID',
      createdBy: 'seed',
      updatedBy: 'seed',
      ...extra,
    } as never,
  })
}

describe.skipIf(!enabled)(
  'outreach context pack on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    let mainOrg = ''
    let mainVenue = ''
    let suppressedOrg = ''
    let blockedElsewhereOrg = ''
    let dncOrg = ''
    let bareOrg = ''
    let bigOrg = ''
    let customerOrg = ''
    let otherOrg = ''
    let otherContact = ''

    beforeAll(async () => {
      await withTenantIsolationBypass(async () => {
        for (const id of [tenantA, tenantB]) {
          await db.tenant.create({ data: { id, name: `Example ${id}`, slug: id } })
        }
      })

      // A healthy prospect: venue, two contacts, evidence, a note and a message.
      mainOrg = (
        await makeOrg(`Example Museum ${suffix}`, 'RESEARCHED', {
          website: 'https://museum.example.com',
          notes: 'Prefers email in the morning.',
          researchProvenance: ['https://museum.example.com/about'],
        })
      ).id
      mainVenue = (
        await makeVenue(mainOrg, 'Example Museum Hall', {
          estimatedSize: 'M',
          fitAttributes: { tier: 'a' },
        })
      ).id
      await makeContact(mainOrg, `c-a-${suffix}`, `a.${suffix}@example.com`, {
        venueId: mainVenue,
        suppressedAt: daysAgo(30),
        suppressionReason: 'asked to stop',
      })
      await makeContact(mainOrg, `c-b-${suffix}`, `b.${suffix}@example.com`, {
        venueId: mainVenue,
        emailReadiness: 'UNVERIFIED',
      })
      await db.prospectSourceEvidence.createMany({
        data: [
          {
            id: `ev-1-${suffix}`,
            organizationId: mainOrg,
            venueId: mainVenue,
            sourceType: 'website',
            sourceUrl: 'https://museum.example.com/visit',
            sourceLabel: 'Visit page',
            capturedValue: { hours: '9 to 5' },
            researchedAt: daysAgo(10),
            createdBy: 'seed',
          },
          {
            id: `ev-2-${suffix}`,
            organizationId: mainOrg,
            sourceType: 'import',
            sourceUrl: 'http://10.0.0.5/private-page',
            researchedAt: null,
            createdBy: 'seed',
          },
        ],
      })
      await db.prospectActivity.create({
        data: {
          organizationId: mainOrg,
          type: 'NOTE_ADDED',
          summary: 'Operator note added',
          detail: 'Spoke with the front desk; write to someone@example.org instead.',
          actorId: 'seed',
          occurredAt: daysAgo(5),
        },
      })
      const thread = await db.prospectEmailThread.create({
        data: {
          organizationId: mainOrg,
          subject: 'Hello',
          replyTokenHash: randomBytes(32).toString('hex'),
        },
      })
      await db.prospectEmailMessage.create({
        data: {
          threadId: thread.id,
          organizationId: mainOrg,
          contactId: `c-b-${suffix}`,
          direction: 'INBOUND',
          status: 'RECEIVED',
          fromAddress: `b.${suffix}@example.com`,
          toAddresses: ['team@example.com'],
          subject: 'Re: Hello',
          bodyPreview: 'Thanks, tell me more.',
          occurredAt: daysAgo(2),
        },
      })

      // Only a suppressed contact.
      suppressedOrg = (await makeOrg(`Suppressed Hall ${suffix}`)).id
      await makeContact(suppressedOrg, `c-s-${suffix}`, `s.${suffix}@example.com`, {
        unsubscribedAt: daysAgo(3),
      })
      await db.prospectContactSuppressionEvent.create({
        data: {
          contactId: `c-s-${suffix}`,
          eventType: 'UNSUBSCRIBED',
          source: 'HUMAN',
          reasonCode: 'requested',
          actorType: 'HUMAN',
          actorId: 'seed',
          occurredAt: daysAgo(3),
        } as never,
      })

      // Clean contact here, but the same address is suppressed on another account.
      blockedElsewhereOrg = (await makeOrg(`Alias Hall ${suffix}`)).id
      await makeContact(blockedElsewhereOrg, `c-e-${suffix}`, `shared.${suffix}@example.com`)
      const aliasHolder = (await makeOrg(`Old Alias Holder ${suffix}`)).id
      await makeContact(aliasHolder, `c-h-${suffix}`, `shared.${suffix}@example.com`, {
        doNotContact: true,
        archivedAt: daysAgo(100),
      })

      dncOrg = (await makeOrg(`No Contact Hall ${suffix}`, 'DO_NOT_CONTACT')).id
      await makeContact(dncOrg, `c-d-${suffix}`, `d.${suffix}@example.com`)

      // No venue, no evidence, no notes, no contact.
      bareOrg = (await makeOrg(`Bare Hall ${suffix}`)).id

      // Far more of everything than a pack carries.
      bigOrg = (await makeOrg(`Big Hall ${suffix}`)).id
      const bigVenue = (await makeVenue(bigOrg, 'Big Hall Main')).id
      await makeContact(bigOrg, `c-big-${suffix}`, `big.${suffix}@example.com`, {
        venueId: bigVenue,
      })
      await db.prospectSourceEvidence.createMany({
        data: Array.from({ length: 14 }, (_, index) => ({
          id: `bev-${String(index).padStart(2, '0')}-${suffix}`,
          organizationId: bigOrg,
          sourceType: 'website',
          sourceUrl: `https://big.example.com/${index}`,
          capturedValue: { text: 'q'.repeat(900) },
          researchedAt: daysAgo(index + 1),
          createdBy: 'seed',
        })),
      })
      await db.prospectActivity.createMany({
        data: Array.from({ length: 8 }, (_, index) => ({
          organizationId: bigOrg,
          type: 'NOTE_ADDED' as const,
          summary: 'Operator note added',
          detail: `Note ${index} ${'w'.repeat(700)}`,
          actorId: 'seed',
          occurredAt: daysAgo(index + 1),
        })),
      })
      const bigThread = await db.prospectEmailThread.create({
        data: {
          organizationId: bigOrg,
          subject: 'Big',
          replyTokenHash: randomBytes(32).toString('hex'),
        },
      })
      await db.prospectEmailMessage.createMany({
        data: Array.from({ length: 8 }, (_, index) => ({
          threadId: bigThread.id,
          organizationId: bigOrg,
          direction: 'OUTBOUND' as const,
          status: 'SENT' as const,
          fromAddress: 'team@example.com',
          toAddresses: [`big.${suffix}@example.com`],
          subject: `Message ${index}`,
          bodyPreview: 'p'.repeat(450),
          occurredAt: daysAgo(index + 10),
        })),
      })

      // A prospect already a customer of tenant B.
      customerOrg = (await makeOrg(`Customer Hall ${suffix}`)).id
      await makeContact(customerOrg, `c-cu-${suffix}`, `cu.${suffix}@example.com`)
      await withTenantIsolationBypass(() =>
        db.prospectConversion.create({
          data: {
            organizationId: customerOrg,
            tenantId: tenantB,
            actorId: 'seed',
            convertedAt: daysAgo(40),
          },
        }),
      )

      otherOrg = (await makeOrg(`Other Hall ${suffix}`)).id
      otherContact = (await makeContact(otherOrg, `c-o-${suffix}`, `o.${suffix}@example.com`)).id
    })

    afterAll(async () => {
      await db.$disconnect()
    })

    it('builds a grounded pack and picks the first draftable contact', async () => {
      const pack = await call({ organizationId: mainOrg })
      expect(pack.drafting.allowed).toBe(true)
      // c-a is suppressed, so auto selection skips it and lands on c-b.
      expect(pack.contact).toMatchObject({ selection: 'auto' })
      expect(pack.contact.chosen).toMatchObject({
        contactId: `c-b-${suffix}`,
        email: `b.${suffix}@example.com`,
        draftEligible: true,
      })
      expect(pack.contact.others).toEqual([
        expect.objectContaining({ contactId: `c-a-${suffix}`, draftEligible: false }),
      ])
      expect(pack.venue).toMatchObject({
        venueId: mainVenue,
        selection: 'contact',
        estimatedSize: 'M',
      })
      expect(pack.organization).toMatchObject({ archived: false, customerLinked: false })
      expect(pack.correspondence).toMatchObject({
        inboundMessages: 1,
        awaitingOurReply: true,
        previewsWithheld: false,
      })
      expect(pack.correspondence.recentMessages[0]).toMatchObject({
        direction: 'INBOUND',
        aboutChosenContact: true,
        preview: { text: 'Thanks, tell me more.' },
      })
      expect(pack.drafting.warnings.map((w: any) => w.code)).toEqual(
        expect.arrayContaining(['awaiting_our_reply', 'not_verified']),
      )
      expect(pack.notes.recorded[0].text.text).toBe(
        'Spoke with the front desk; write to [address withheld] instead.',
      )
      expect(pack.notes.embedded.text).toBe('Prefers email in the morning.')
      // Evidence: dated public page first, undated private-host item flagged and its URL withheld.
      expect(pack.evidence.items).toHaveLength(2)
      expect(pack.evidence.items[0]).toMatchObject({
        evidenceId: `ev-1-${suffix}`,
        sourceUrl: 'https://museum.example.com/visit',
        freshness: { status: 'fresh', ageDays: 10 },
      })
      expect(pack.evidence.items[1]).toMatchObject({
        sourceUrl: null,
        urlWithheld: true,
        freshness: { status: 'unknown' },
      })
      expect(pack.evidence.legacySources.map((s: any) => s.sourceUrl)).toEqual([
        'https://museum.example.com/about',
      ])
      expect(pack.limits.complete).toBe(true)
      // Another contact's address never appears.
      expect(JSON.stringify(pack)).not.toContain(`a.${suffix}@example.com`)
    })

    it('refuses drafting for an explicitly chosen suppressed contact and withholds free text', async () => {
      const pack = await call({ organizationId: mainOrg, contactId: `c-a-${suffix}` })
      expect(pack.drafting.allowed).toBe(false)
      expect(pack.contact.selection).toBe('requested')
      expect(pack.contact.chosen).toMatchObject({
        contactId: `c-a-${suffix}`,
        email: null,
        draftEligible: false,
        flags: { suppressed: true },
      })
      expect(pack.drafting.blockers).toEqual([
        expect.objectContaining({ code: 'suppressed', scope: 'contact' }),
      ])
      expect(pack.notes).toMatchObject({ withheld: true, recorded: [], embedded: null })
      expect(pack.evidence).toMatchObject({ withheld: true, items: [], legacySources: [] })
      expect(pack.correspondence.previewsWithheld).toBe(true)
      expect(pack.correspondence.recentMessages[0].preview).toBeNull()
      expect(JSON.stringify(pack)).not.toContain('Thanks, tell me more')
      expect(JSON.stringify(pack)).not.toContain('front desk')
      expect(JSON.stringify(pack)).not.toContain(`a.${suffix}@example.com`)
    })

    it('refuses an unsubscribed-only account with the suppression ledger entry', async () => {
      const pack = await call({ organizationId: suppressedOrg })
      expect(pack.drafting.allowed).toBe(false)
      expect(pack.contact.selection).toBe('none')
      expect(pack.contact.chosen).toBeNull()
      expect(pack.drafting.blockers.map((b: any) => b.code)).toEqual(['no_draftable_contact'])
      const explicit = await call({ organizationId: suppressedOrg, contactId: `c-s-${suffix}` })
      expect(explicit.drafting.blockers.map((b: any) => b.code)).toEqual(['unsubscribed'])
      expect(explicit.contact.chosen.lastSuppressionEvent).toMatchObject({
        eventType: 'UNSUBSCRIBED',
        reasonCode: 'requested',
      })
      expect(explicit.contact.chosen.flags.unsubscribed).toBe(true)
    })

    it('treats an address blocked on another (archived) record as a blocker', async () => {
      const pack = await call({ organizationId: blockedElsewhereOrg, contactId: `c-e-${suffix}` })
      expect(pack.drafting.allowed).toBe(false)
      expect(pack.drafting.blockers.map((b: any) => b.code)).toEqual(['address_blocked_elsewhere'])
    })

    it('blocks a do-not-contact account', async () => {
      const pack = await call({ organizationId: dncOrg })
      expect(pack.drafting.allowed).toBe(false)
      expect(pack.drafting.blockers.map((b: any) => b.code)).toContain(
        'organization_do_not_contact',
      )
    })

    it('says plainly what is missing when there is no venue, contact or evidence', async () => {
      const pack = await call({ organizationId: bareOrg })
      expect(pack.drafting.allowed).toBe(false)
      expect(pack.drafting.blockers.map((b: any) => b.code)).toEqual(['no_contact'])
      expect(pack.venue).toBeNull()
      expect(pack.drafting.warnings.map((w: any) => w.code)).toContain('no_venue')
      const status = Object.fromEntries(pack.claims.map((c: any) => [c.claim, c.status]))
      expect(status.venue_specific_facts).toBe('unsupported')
      expect(status.prior_relationship_or_conversation).toBe('unsupported')
      expect(pack.evidence.section).toMatchObject({ total: 0, returned: 0, truncated: false })
    })

    it('bounds every list and marks each truncation', async () => {
      const pack = await call({ organizationId: bigOrg })
      expect(pack.drafting.allowed).toBe(true)
      expect(pack.evidence.items).toHaveLength(10)
      expect(pack.evidence.section).toMatchObject({ total: 14, returned: 10, truncated: true })
      // Newest research first.
      expect(pack.evidence.items[0].evidenceId).toBe(`bev-00-${suffix}`)
      expect(pack.evidence.items[0].capturedValue.truncated).toBe(true)
      expect(pack.notes.recorded).toHaveLength(5)
      expect(pack.notes.section).toMatchObject({ total: 8, returned: 5, truncated: true })
      expect(pack.notes.recorded[0].text).toMatchObject({ truncated: true })
      expect(pack.correspondence.recentMessages).toHaveLength(5)
      expect(pack.correspondence.messageSection).toMatchObject({ total: 8, truncated: true })
      expect(pack.limits.complete).toBe(false)
      expect(pack.limits.truncatedSections).toEqual(['evidence', 'messages', 'notes'])
      expect(pack.limits.approxChars).toBeLessThan(30_000)
    })

    it('is deterministic: equal data gives an equal pack and fingerprint', async () => {
      const first = await call({ organizationId: mainOrg })
      const second = await call({ organizationId: mainOrg })
      expect(second).toEqual(first)
      const big1 = await call({ organizationId: bigOrg })
      expect(await call({ organizationId: bigOrg })).toEqual(big1)
      await db.prospectActivity.create({
        data: {
          organizationId: mainOrg,
          type: 'NOTE_ADDED',
          summary: 'Operator note added',
          detail: 'A newer note',
          actorId: 'seed',
          occurredAt: daysAgo(1),
        },
      })
      const changed = await call({ organizationId: mainOrg })
      expect(changed.sourceFingerprint).not.toBe(first.sourceFingerprint)
      expect(changed.notes.recorded[0].text.text).toBe('A newer note')
    })

    it('denies cross-tenant, cross-account and ungranted reads as not found', async () => {
      // Converted to tenant B: invisible to a tenant A connection, visible to B.
      await expect(call({ organizationId: customerOrg })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      const visible = await call({ organizationId: customerOrg }, grant([tenantB]))
      expect(visible.organization.customerLinked).toBe(true)
      expect(visible.drafting.allowed).toBe(true)
      // A contact of another account cannot be named, a venue of another account cannot either.
      await expect(
        call({ organizationId: mainOrg, contactId: otherContact }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(call({ organizationId: otherOrg, venueId: mainVenue })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(call({ organizationId: `missing-${suffix}` })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      // No crm:read capability: refused before any read.
      await expect(
        call({ organizationId: mainOrg }, grant([tenantA], ['operator:read'])),
      ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    })

    it('checks tenant authority beyond the first fifty active relationships', async () => {
      const organization = await makeOrg(`Many relationships ${suffix}`)
      await withTenantIsolationBypass(async () => {
        await db.prospectCustomerRelationship.createMany({
          data: Array.from({ length: 51 }, (_, index) => ({
            organizationId: organization.id,
            tenantId: index === 50 ? tenantB : tenantA,
            relationshipVersion: index + 1,
            idempotencyKey: `outreach-relationship-${suffix}-${index}`,
            createdBy: 'seed',
          })),
        })
      })
      await expect(call({ organizationId: organization.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      const visible = await call({ organizationId: organization.id }, grant([tenantA, tenantB]))
      expect(visible.organization.customerLinked).toBe(true)
    })

    it('rejects unknown arguments and writes nothing', async () => {
      const before = await db.prospectActivity.count({ where: { organizationId: mainOrg } })
      await expect(call({ organizationId: mainOrg, tenantId: tenantA })).rejects.toThrow()
      await call({ organizationId: mainOrg })
      expect(await db.prospectActivity.count({ where: { organizationId: mainOrg } })).toBe(before)
    })
  },
)
