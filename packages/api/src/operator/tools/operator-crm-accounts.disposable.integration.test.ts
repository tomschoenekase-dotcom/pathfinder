/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  OPERATOR_MCP_OUTPUTS,
  OperatorCapability,
  type OperatorReadToolName,
} from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import { OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import { createOperatorRegistry, defaultVenueRead } from '../registry'
import { OperatorInvalidCursorError } from './page'

/**
 * Account resolution, context and complete-history reads on a real disposable PostgreSQL. Invented
 * names and example domains only. Runs only against a database named pathfinder_disposable_*.
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
const tenantId = `acct-tenant-${suffix}`
const otherTenantId = `acct-other-${suffix}`
const brand = `Zorbel${suffix.slice(0, 6)}`

function grant(tenantIds: string[] = [tenantId]): VerifiedOperatorGrant {
  return {
    grantId: `grant-${suffix}`,
    clientId: 'client-example',
    userId: 'user_owner',
    allTenants: false,
    tenantIds,
    capabilities: [...OperatorCapability.options],
  }
}

const registry = createOperatorRegistry()
async function call(
  name: OperatorReadToolName,
  args: Record<string, unknown>,
  operatorGrant = grant(),
) {
  const output = await registry.callTool(name, args, {
    config,
    database: db,
    grant: operatorGrant,
    now: new Date(),
    requestId: randomUUID(),
    venueRead: defaultVenueRead(db),
  })
  return OPERATOR_MCP_OUTPUTS[name].parse(output) as any
}

async function pages(
  name: OperatorReadToolName,
  args: Record<string, unknown>,
  pick: (page: any) => any[],
) {
  const items: any[] = []
  const sizes: number[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await call(name, { ...args, ...(cursor ? { cursor } : {}) })
    expect(page.complete).toBe(page.nextCursor === null)
    const got = pick(page)
    items.push(...got)
    sizes.push(got.length)
    if (page.nextCursor === null) return { items, sizes }
    cursor = page.nextCursor
  }
  throw new Error('pagination did not terminate')
}

async function makeOrg(
  name: string,
  extra: Record<string, unknown> = {},
  venues: Array<{ name: string; city: string; region?: string; website?: string }> = [],
) {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
  return db.prospectOrganization.create({
    data: {
      canonicalName: name,
      normalizedName: normalized,
      createdBy: 'seed',
      updatedBy: 'seed',
      opportunity: { create: { stage: 'RESEARCHED', createdBy: 'seed', updatedBy: 'seed' } },
      ...(venues.length > 0
        ? {
            venues: {
              create: venues.map((venue) => ({
                name: venue.name,
                normalizedName: venue.name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/gu, ' ')
                  .trim(),
                city: venue.city,
                region: venue.region ?? 'EX',
                normalizedDomain: venue.website ?? null,
                createdBy: 'seed',
                updatedBy: 'seed',
              })),
            },
          }
        : {}),
      ...extra,
    } as never,
  })
}

describe.skipIf(!enabled)(
  'operator account reads on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    let twinA = ''
    let twinB = ''
    let aliasOrg = ''
    let domainOrg = ''
    let customerOrg = ''
    let contactOrg = ''
    let historyOrg = ''

    beforeAll(async () => {
      await withTenantIsolationBypass(async () => {
        for (const id of [tenantId, otherTenantId]) {
          await db.tenant.create({ data: { id, name: `Example ${id}`, slug: id } })
        }
      })
      // Two accounts a careless search would conflate: same trade name, different cities.
      twinA = (
        await makeOrg(`${brand} Garden`, {
          headquartersCity: 'Springfield',
          headquartersRegion: 'IL',
        })
      ).id
      twinB = (
        await makeOrg(`${brand} Garden`, {
          headquartersCity: 'Shelbyville',
          headquartersRegion: 'KY',
        })
      ).id
      aliasOrg = (
        await makeOrg(`Quillon Holdings ${suffix}`, {
          aliases: [`The ${brand} Arboretum`, 'Quillon Arbor'],
          headquartersCity: 'Ogdenville',
        })
      ).id
      domainOrg = (
        await makeOrg(`Plain Name ${suffix}`, {
          website: `https://www.${suffix}-example.org/about`,
          normalizedDomain: `${suffix}-example.org`,
        })
      ).id
      await db.prospectContact.create({
        data: {
          organizationId: domainOrg,
          fullName: 'Casey Example',
          email: `casey.${suffix}@old-address.example.com`,
          normalizedEmail: `casey.${suffix}@old-address.example.com`,
          archivedAt: new Date(),
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      })
      // A prospect that already became a customer in the granted tenant.
      customerOrg = (
        await makeOrg(`Customer ${brand} Society`, { headquartersCity: 'Capital City' }, [
          { name: `${brand} Society Hall`, city: 'Capital City' },
        ])
      ).id
      await withTenantIsolationBypass(() =>
        db.prospectConversion.create({
          data: { organizationId: customerOrg, tenantId, actorId: 'seed', convertedAt: new Date() },
        }),
      )

      // 51 contacts and 21 notes on one account.
      contactOrg = (await makeOrg(`Big Roster ${suffix}`)).id
      await db.prospectContact.createMany({
        data: Array.from({ length: 51 }, (_, index) => ({
          organizationId: contactOrg,
          fullName: `Person ${String(index).padStart(2, '0')}`,
          email: `p${index}.${suffix}@example.com`,
          normalizedEmail: `p${index}.${suffix}@example.com`,
          // Every tenth contact opted out: its address must never appear.
          ...(index % 10 === 0 ? { suppressedAt: new Date() } : {}),
          createdBy: 'seed',
          updatedBy: 'seed',
        })),
      })
      await db.prospectActivity.createMany({
        data: Array.from({ length: 21 }, (_, index) => ({
          organizationId: contactOrg,
          type: 'NOTE_ADDED' as const,
          summary: 'Operator note added',
          detail: `Note ${index}`,
          actorId: 'seed',
          occurredAt: new Date(Date.UTC(2026, 8, 1, 12, index, 0)),
        })),
      })

      // 201 history events, many sharing one instant, across both streams.
      historyOrg = (await makeOrg(`History ${suffix}`)).id
      const tie = new Date('2026-09-10T10:00:00.000Z')
      await db.prospectActivity.createMany({
        data: Array.from({ length: 150 }, (_, index) => ({
          organizationId: historyOrg,
          type: 'NOTE_ADDED' as const,
          summary: `activity-${String(index).padStart(3, '0')}`,
          actorId: 'seed',
          // Three instants shared by 50 events each.
          occurredAt: new Date(tie.getTime() - Math.floor(index / 50) * 3_600_000),
        })),
      })
      const thread = await db.prospectEmailThread.create({
        data: {
          organizationId: historyOrg,
          subject: 'Example thread',
          replyTokenHash: randomBytes(32).toString('hex'),
        },
      })
      await db.prospectEmailMessage.createMany({
        data: Array.from({ length: 51 }, (_, index) => ({
          threadId: thread.id,
          organizationId: historyOrg,
          direction: index % 2 === 0 ? ('OUTBOUND' as const) : ('INBOUND' as const),
          status: 'SENT' as const,
          fromAddress: 'sender@example.com',
          toAddresses: ['recipient@example.com'],
          subject: `message-${String(index).padStart(3, '0')}`,
          occurredAt: new Date(tie.getTime() - Math.floor(index / 17) * 3_600_000),
        })),
      })
    })

    afterAll(async () => {
      await withTenantIsolationBypass(() =>
        db.embeddingDispatch.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }),
      )
      await db.$disconnect()
    })

    it('resolves a name shared by two accounts as ambiguous, and a location narrows it to one', async () => {
      const ambiguous = await call('crm.resolve_account', { name: `${brand} Garden` })
      expect(ambiguous.resolution).toBe('ambiguous')
      expect(ambiguous.candidates.map((c: any) => c.organizationId).sort()).toEqual(
        [twinA, twinB].sort(),
      )
      expect(ambiguous.nextAction).toMatch(/ask the user/iu)

      const narrowed = await call('crm.resolve_account', {
        name: `${brand} Garden`,
        city: 'Shelbyville',
      })
      expect(narrowed.resolution).toBe('unique')
      expect(narrowed.candidates[0]).toMatchObject({
        organizationId: twinB,
        strength: 'exact',
        region: 'KY',
      })
    })

    it('finds an account by an alias it is known under, by a venue name, and by domain', async () => {
      const byAlias = await call('crm.resolve_account', { name: `the ${brand} arboretum` })
      expect(byAlias.resolution).toBe('unique')
      expect(byAlias.candidates[0]).toMatchObject({
        organizationId: aliasOrg,
        matchedOn: ['alias'],
        matchedAlias: `The ${brand} Arboretum`,
      })
      const byVenue = await call('crm.resolve_account', { name: `${brand} Society Hall` })
      expect(byVenue.candidates[0]).toMatchObject({
        organizationId: customerOrg,
        matchedOn: expect.arrayContaining(['venue_name']),
      })
      const byDomain = await call('crm.resolve_account', {
        domain: `https://${suffix}-example.org/x`,
      })
      expect(byDomain.candidates.map((c: any) => c.organizationId)).toContain(domainOrg)
    })

    it('finds an account by an old, archived address and never reports a name match as proof', async () => {
      const byEmail = await call('crm.resolve_account', {
        email: `Casey.${suffix}@old-address.example.com`,
      })
      expect(byEmail.resolution).toBe('unique')
      expect(byEmail.candidates[0]).toMatchObject({
        organizationId: domainOrg,
        matchedOn: ['email'],
      })
      const partial = await call('crm.resolve_account', { name: `${brand}` })
      // A bare brand is a candidate list, not an identity.
      expect(partial.resolution).toBe('ambiguous')
      expect(partial.candidates.every((c: any) => c.strength !== 'exact')).toBe(true)
      expect((await call('crm.resolve_account', { name: `no-such-${suffix}` })).resolution).toBe(
        'none',
      )
    })

    it('returns the existing customer for a converted prospect, naming the tenant only inside the grant', async () => {
      const inside = await call('crm.resolve_account', { name: `Customer ${brand} Society` })
      expect(inside.candidates[0].customer).toMatchObject({ tenantId, venueId: null })
      const outside = await call(
        'crm.resolve_account',
        { name: `Customer ${brand} Society` },
        grant([otherTenantId]),
      )
      // Linked, but the tenant it belongs to is outside this connection, so it is not named.
      expect(outside.candidates[0].customer).toMatchObject({ tenantId: null, venueId: null })
      const context = await call('crm.get_account_context', { organizationId: customerOrg })
      expect(context.customer).toMatchObject({ tenantId })
    })

    it('opens the whole account in one call with the version writes expect', async () => {
      const context = await call('crm.get_account_context', { organizationId: contactOrg })
      expect(context.contacts).toMatchObject({
        total: 51,
        suppressed: 6,
        contactable: 45,
        archived: 0,
      })
      expect(context.history).toMatchObject({ activityCount: 21, noteCount: 21 })
      // Version is 1 plus the activity count: the number crm.propose_stage_change expects.
      expect(context.organization.version).toBe(22)
      expect(JSON.stringify(context)).not.toMatch(/@example\.com/u)
      const withAliases = await call('crm.get_account_context', { organizationId: aliasOrg })
      expect(withAliases.organization.aliases).toEqual([`The ${brand} Arboretum`, 'Quillon Arbor'])
      await expect(
        call('crm.get_account_context', { organizationId: 'missing' }),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
    })

    it('lists every one of 51 contacts across pages, withholding blocked addresses and noting edit tokens', async () => {
      const all = await pages(
        'crm.list_contacts',
        { organizationId: contactOrg },
        (page) => page.items,
      )
      expect(all.sizes).toEqual([25, 25, 1])
      expect(new Set(all.items.map((item) => item.contactId)).size).toBe(51)
      const withAddress = all.items.filter((item) => item.email !== null)
      expect(withAddress).toHaveLength(45)
      for (const item of all.items) {
        expect(new Date(item.updatedAt).getTime()).toBeGreaterThan(0)
        if (!item.contactable) expect(item.email).toBeNull()
      }
      await expect(
        call('crm.list_contacts', { organizationId: contactOrg, cursor: 'not-a-contact' }),
      ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
    })

    it('lists all 21 notes newest first without skipping equal timestamps', async () => {
      const all = await pages(
        'crm.list_notes',
        { organizationId: contactOrg, limit: 10 },
        (page) => page.items,
      )
      expect(all.sizes).toEqual([10, 10, 1])
      expect(all.items[0].text.text).toBe('Note 20')
      expect(new Set(all.items.map((item) => item.noteId)).size).toBe(21)
      await expect(
        call('crm.list_notes', {
          organizationId: contactOrg,
          cursor: `${new Date().toISOString()}|nope`,
        }),
      ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
    })

    it('pages all 201 history events once each, even across timestamps shared by many events', async () => {
      const all = await pages(
        'crm.get_contact_history',
        { organizationId: historyOrg, limit: 50 },
        (page) => page.events,
      )
      expect(all.items).toHaveLength(150 + 51)
      const labels = all.items.map((event) => event.summary.text)
      expect(new Set(labels.map((label: string) => label.replace(/^[A-Z]+: /u, ''))).size).toBe(201)
      // Newest first, and the order never goes backwards across a page boundary.
      const times = all.items.map((event) => new Date(event.occurredAt).getTime())
      expect([...times].sort((a, b) => b - a)).toEqual(times)
      await expect(
        call('crm.get_contact_history', { organizationId: historyOrg, cursor: 'h:bad' }),
      ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
      // A cursor from another account's history is refused, not used as an ordering oracle.
      const foreign = await call('crm.get_contact_history', {
        organizationId: historyOrg,
        limit: 1,
      })
      await expect(
        call('crm.get_contact_history', { organizationId: contactOrg, cursor: foreign.nextCursor }),
      ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
    })
  },
)
