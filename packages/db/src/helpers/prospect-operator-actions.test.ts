import { describe, expect, it, vi } from 'vitest'

import { ProspectActionError, ProspectDuplicateReviewError } from './prospect-actions'
import {
  changeProspectContactAddressAction,
  createProspectForOperatorAction,
  resolveProspectOwner,
  updateProspectAccountAction,
} from './prospect-operator-actions'

const actor = { type: 'HUMAN' as const, id: 'user_owner', role: 'PLATFORM_ADMIN' as const }
const READ_AT = new Date('2026-09-01T00:00:00.000Z')

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    canonicalName: 'Example Museum',
    website: 'https://www.example-museum.test',
    normalizedDomain: 'example-museum.test',
    aliases: ['The Example'],
    organizationType: 'Museum',
    headquartersCity: 'Sampleton',
    headquartersRegion: 'North',
    headquartersCountry: null,
    archivedAt: null,
    updatedAt: READ_AT,
    opportunity: { id: 'opp-1', ownerId: 'user_a', updatedAt: READ_AT },
    tagAssignments: [],
    ...overrides,
  }
}

function accountClient(options: { row?: Record<string, unknown>; activities?: number } = {}) {
  const row = accountRow(options.row)
  const tx = {
    prospectActivity: {
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(options.activities ?? 3),
      create: vi.fn().mockResolvedValue({}),
    },
    prospectOrganization: {
      findUnique: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prospectOpportunity: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    prospectTag: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    prospectOrganizationTag: { upsert: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  const client = { $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)) }
  return { tx, client }
}

describe('updateProspectAccountAction', () => {
  it('rejects a stale version before writing anything', async () => {
    const { tx, client } = accountClient({ activities: 5 })
    await expect(
      updateProspectAccountAction(
        { organizationId: 'org-1', expectedVersion: 4, name: 'Renamed', actor },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.prospectOrganization.updateMany).not.toHaveBeenCalled()
    expect(tx.prospectActivity.create).not.toHaveBeenCalled()
  })

  it('rejects a stale updatedAt guard', async () => {
    const { tx, client } = accountClient()
    await expect(
      updateProspectAccountAction(
        {
          organizationId: 'org-1',
          expectedVersion: 4,
          expectedUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
          name: 'Renamed',
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.prospectOrganization.updateMany).not.toHaveBeenCalled()
  })

  it('leaves omitted fields alone and clears only the field sent as null', async () => {
    const { tx, client } = accountClient()
    const saved = await updateProspectAccountAction(
      { organizationId: 'org-1', expectedVersion: 4, website: null, actor },
      client as never,
    )
    const data = tx.prospectOrganization.updateMany.mock.calls[0]![0].data
    expect(data).toMatchObject({ website: null, normalizedDomain: null })
    for (const untouched of [
      'canonicalName',
      'aliases',
      'organizationType',
      'headquartersCity',
      'headquartersRegion',
      'headquartersCountry',
      'tags',
    ]) {
      expect(data).not.toHaveProperty(untouched)
    }
    expect(saved.changes).toEqual([
      { field: 'website', from: 'https://www.example-museum.test', to: null },
    ])
    // The owner column is the opportunity's, and it was not named, so it was not touched.
    expect(tx.prospectOpportunity.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.prospectOpportunity.updateMany.mock.calls[0]![0].data).not.toHaveProperty('ownerId')
  })

  it('reports exactly the fields that changed and none that were sent unchanged', async () => {
    const { tx, client } = accountClient()
    const saved = await updateProspectAccountAction(
      {
        organizationId: 'org-1',
        expectedVersion: 4,
        // Same as stored, so it must not be reported or written.
        name: 'Example Museum',
        city: 'Newtown',
        country: null,
        actor,
      },
      client as never,
    )
    expect(saved.changes.map((change) => change.field)).toEqual(['city'])
    const data = tx.prospectOrganization.updateMany.mock.calls[0]![0].data
    expect(data).toMatchObject({ headquartersCity: 'Newtown' })
    expect(data).not.toHaveProperty('canonicalName')
    expect(data).not.toHaveProperty('headquartersCountry')
  })

  it('writes nothing when every sent field already matches', async () => {
    const { tx, client } = accountClient()
    const saved = await updateProspectAccountAction(
      { organizationId: 'org-1', expectedVersion: 4, city: 'Sampleton', actor },
      client as never,
    )
    expect(saved.changes).toEqual([])
    expect(tx.prospectOrganization.updateMany).not.toHaveBeenCalled()
    expect(tx.prospectActivity.create).not.toHaveBeenCalled()
  })

  it('refuses to clear the name', async () => {
    const { client } = accountClient()
    await expect(
      updateProspectAccountAction(
        { organizationId: 'org-1', expectedVersion: 4, name: '   ', actor },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('stops for duplicate review when the new name or domain belongs to another account', async () => {
    const { tx, client } = accountClient()
    tx.prospectOrganization.findMany.mockResolvedValue([
      {
        id: 'org-2',
        canonicalName: 'Other Museum',
        normalizedName: 'other museum',
        normalizedDomain: 'other-museum.test',
      },
    ])
    const attempt = updateProspectAccountAction(
      { organizationId: 'org-1', expectedVersion: 4, website: 'https://other-museum.test', actor },
      client as never,
    )
    await expect(attempt).rejects.toBeInstanceOf(ProspectDuplicateReviewError)
    await expect(attempt).rejects.toMatchObject({
      code: 'DUPLICATE_REVIEW',
      matches: [{ organizationId: 'org-2', matchedOn: ['domain'] }],
    })
    expect(tx.prospectOrganization.updateMany).not.toHaveBeenCalled()
  })

  it('sets the owner on the opportunity and records one receipt activity', async () => {
    const { tx, client } = accountClient()
    const saved = await updateProspectAccountAction(
      {
        organizationId: 'org-1',
        expectedVersion: 4,
        ownerId: 'user_b',
        operationKey: 'op-1',
        actor,
      },
      client as never,
    )
    expect(tx.prospectOpportunity.updateMany.mock.calls[0]![0].data).toMatchObject({
      ownerId: 'user_b',
    })
    expect(tx.prospectActivity.create).toHaveBeenCalledTimes(1)
    expect(tx.prospectActivity.create.mock.calls[0]![0].data.externalReceiptKey).toBe(
      'operator:op-1:account-update',
    )
    expect(saved.changes).toEqual([{ field: 'ownerId', from: 'user_a', to: 'user_b' }])
  })

  it('replays from the receipt without a second write', async () => {
    const { tx, client } = accountClient()
    tx.prospectActivity.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      evidence: { changes: [{ field: 'city', from: 'Sampleton', to: 'Newtown' }] },
    })
    const saved = await updateProspectAccountAction(
      { organizationId: 'org-1', expectedVersion: 4, city: 'Newtown', operationKey: 'op-1', actor },
      client as never,
    )
    expect(saved.replayed).toBe(true)
    expect(saved.changes.map((change) => change.field)).toEqual(['city'])
    expect(tx.prospectOrganization.updateMany).not.toHaveBeenCalled()
  })

  it('refuses a non-platform actor before any database work', async () => {
    const { client } = accountClient()
    await expect(
      updateProspectAccountAction(
        {
          organizationId: 'org-1',
          expectedVersion: 4,
          name: 'X',
          actor: { type: 'HUMAN', id: 'staff', role: 'STAFF' } as never,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})

describe('resolveProspectOwner', () => {
  it('finds an owner only through the directory, by exact id or address', async () => {
    const user = {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'user_b', email: 'b@example.test', fullName: 'B' }),
      findFirst: vi.fn().mockResolvedValue(null),
    }
    await expect(
      resolveProspectOwner({ user } as never, { userId: 'user_b' }),
    ).resolves.toMatchObject({ id: 'user_b' })
    await expect(
      resolveProspectOwner({ user } as never, { email: 'Nobody@Example.test' }),
    ).resolves.toBeNull()
    expect(user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'nobody@example.test', mode: 'insensitive' } },
      }),
    )
  })
})

const OLD_AT = new Date('2026-09-02T00:00:00.000Z')

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contact-old',
    organizationId: 'org-1',
    venueId: 'venue-1',
    fullName: 'Sam Example',
    title: 'Director',
    email: 'sam@old.example.test',
    normalizedEmail: 'sam@old.example.test',
    phone: '+1 555 0100',
    preferredCommunication: null,
    provenance: [{ source: 'import' }],
    emailReadiness: 'READY',
    permissionState: 'VERIFIED',
    doNotContact: false,
    suppressionReason: null,
    suppressedAt: null,
    unsubscribedAt: null,
    complainedAt: null,
    lastHardBounceAt: new Date('2026-08-01T00:00:00.000Z'),
    archivedAt: null,
    updatedAt: OLD_AT,
    organization: { archivedAt: null, opportunity: { stage: 'CONTACTED' } },
    ...overrides,
  }
}

function addressClient(oldRow = contactRow(), blockedElsewhere = false) {
  const tx = {
    prospectActivity: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    prospectContact: {
      findUnique: vi.fn().mockResolvedValue(oldRow),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...oldRow, archivedAt: new Date() }),
      // First call is the blocked-anywhere probe, second the same-account probe.
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(blockedElsewhere ? { id: 'blocked-row' } : null)
        .mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 'contact-new', updatedAt: new Date(), ...data }),
        ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    prospectOpportunity: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  const client = { $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)) }
  return { tx, client }
}

describe('changeProspectContactAddressAction', () => {
  const base = {
    contactId: 'contact-old',
    expectedUpdatedAt: OLD_AT,
    newEmail: 'Sam@New.Example.test',
    retireOldAddress: true,
    reason: 'Sam moved to the new domain',
    operationKey: 'op-addr',
    actor,
  }

  it('adds the new address as a new contact and keeps the old row, its history and its blocks', async () => {
    const { tx, client } = addressClient()
    const saved = await changeProspectContactAddressAction(base, client as never)

    const created = tx.prospectContact.create.mock.calls[0]![0].data
    expect(created).toMatchObject({
      normalizedEmail: 'sam@new.example.test',
      fullName: 'Sam Example',
      phone: '+1 555 0100',
    })
    // The new address inherits no consent or readiness: it is verified on its own.
    for (const carried of ['permissionState', 'emailReadiness', 'doNotContact', 'suppressedAt']) {
      expect(created).not.toHaveProperty(carried)
    }

    // The old row is only archived and annotated; its address, suppression and bounce are untouched.
    const oldUpdate = tx.prospectContact.updateMany.mock.calls[0]![0]
    expect(oldUpdate.where).toEqual({ id: 'contact-old', updatedAt: OLD_AT })
    for (const kept of [
      'email',
      'normalizedEmail',
      'doNotContact',
      'suppressedAt',
      'suppressionReason',
      'unsubscribedAt',
      'complainedAt',
      'lastHardBounceAt',
      'permissionState',
      'emailReadiness',
    ]) {
      expect(oldUpdate.data).not.toHaveProperty(kept)
    }
    expect(oldUpdate.data.archivedAt).toBeInstanceOf(Date)
    expect(tx.prospectContact.delete).not.toHaveBeenCalled()
    expect(tx.prospectContact.deleteMany).not.toHaveBeenCalled()

    // One receipt on the new contact's activity; correspondence is not moved or rewritten.
    const receipts = tx.prospectActivity.create.mock.calls
      .map((call) => call[0].data.externalReceiptKey)
      .filter(Boolean)
    expect(receipts).toEqual(['operator:op-addr:contact-address-change'])
    expect(saved.replayed).toBe(false)
  })

  it('does not archive the old row when asked to keep it active', async () => {
    const { tx, client } = addressClient()
    await changeProspectContactAddressAction({ ...base, retireOldAddress: false }, client as never)
    expect(tx.prospectContact.updateMany.mock.calls[0]![0].data).not.toHaveProperty('archivedAt')
  })

  it('never overrides a suppression on the new address', async () => {
    const { tx, client } = addressClient(contactRow(), true)
    await expect(changeProspectContactAddressAction(base, client as never)).rejects.toMatchObject({
      code: 'SUPPRESSED',
    })
    expect(tx.prospectContact.create).not.toHaveBeenCalled()
    expect(tx.prospectContact.updateMany).not.toHaveBeenCalled()
  })

  it('stops when the person declined, complained or the account is do-not-contact', async () => {
    for (const overrides of [
      { unsubscribedAt: new Date() },
      { complainedAt: new Date() },
      { doNotContact: true },
      { permissionState: 'OPTED_OUT' },
      { suppressedAt: new Date(), lastHardBounceAt: null },
      { organization: { archivedAt: null, opportunity: { stage: 'DO_NOT_CONTACT' } } },
    ]) {
      const { tx, client } = addressClient(contactRow(overrides))
      await expect(changeProspectContactAddressAction(base, client as never)).rejects.toMatchObject(
        { code: 'SUPPRESSED' },
      )
      expect(tx.prospectContact.create).not.toHaveBeenCalled()
    }
  })

  it('rejects a stale contact', async () => {
    const { tx, client } = addressClient(
      contactRow({ updatedAt: new Date('2026-09-09T00:00:00Z') }),
    )
    await expect(changeProspectContactAddressAction(base, client as never)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.prospectContact.create).not.toHaveBeenCalled()
  })

  it('replays from the receipt without creating a second contact', async () => {
    const { tx, client } = addressClient()
    tx.prospectActivity.findUnique.mockResolvedValue({
      contactId: 'contact-new',
      evidence: { replacesContactId: 'contact-old' },
    })
    tx.prospectContact.findUniqueOrThrow.mockResolvedValue({ id: 'contact-new' })
    const saved = await changeProspectContactAddressAction(base, client as never)
    expect(saved.replayed).toBe(true)
    expect(tx.prospectContact.create).not.toHaveBeenCalled()
  })

  it('rejects an invalid or unchanged address', async () => {
    const { client } = addressClient()
    await expect(
      changeProspectContactAddressAction({ ...base, newEmail: 'not-an-address' }, client as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const same = addressClient()
    await expect(
      changeProspectContactAddressAction(
        { ...base, newEmail: 'sam@old.example.test' },
        same.client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

function createClient(matches: Array<Record<string, unknown>> = [], blocked = false) {
  let receipt: Record<string, unknown> | null = null
  const tx = {
    prospectActivity: {
      findUnique: vi.fn().mockImplementation(() => Promise.resolve(receipt)),
      create: vi.fn().mockImplementation(({ data }) => {
        if (data.externalReceiptKey) {
          receipt = {
            organizationId: data.organizationId,
            venueId: data.venueId ?? null,
            contactId: data.contactId ?? null,
          }
        }
        return Promise.resolve({})
      }),
    },
    prospectOrganization: {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(receipt ? [] : matches)),
      create: vi.fn().mockResolvedValue({ id: 'org-new' }),
    },
    prospectVenue: { create: vi.fn().mockResolvedValue({ id: 'venue-new' }) },
    prospectContact: {
      findFirst: vi.fn().mockResolvedValue(blocked ? { id: 'blocked' } : null),
      create: vi.fn().mockResolvedValue({ id: 'contact-new', doNotContact: false }),
    },
    prospectTag: { upsert: vi.fn() },
    prospectOrganizationTag: { upsert: vi.fn() },
    prospectContactSuppressionEvent: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  const client = { $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)) }
  return { tx, client }
}

describe('createProspectForOperatorAction', () => {
  const input = {
    organization: { canonicalName: 'Example Museum', website: 'https://example-museum.test' },
    venue: { name: 'Main site', city: 'Sampleton' },
    contact: { fullName: 'Sam Example', email: 'sam@example-museum.test' },
    operationKey: 'op-create',
    actor,
  }

  it('stops with the matches on an exact name match and creates nothing', async () => {
    const { tx, client } = createClient([
      {
        id: 'org-existing',
        canonicalName: 'Example Museum',
        normalizedName: 'example museum',
        normalizedDomain: 'unrelated.test',
      },
    ])
    const attempt = createProspectForOperatorAction(input, client as never)
    await expect(attempt).rejects.toBeInstanceOf(ProspectDuplicateReviewError)
    await expect(attempt).rejects.toMatchObject({
      code: 'DUPLICATE_REVIEW',
      matches: [{ organizationId: 'org-existing', matchedOn: ['name'] }],
    })
    expect(tx.prospectOrganization.create).not.toHaveBeenCalled()
  })

  it('stops for decision when a different-named account shares the domain (ambiguous shared domain)', async () => {
    const { tx, client } = createClient([
      {
        id: 'org-parent',
        canonicalName: 'Parent Group',
        normalizedName: 'parent group',
        normalizedDomain: 'example-museum.test',
      },
    ])
    await expect(createProspectForOperatorAction(input, client as never)).rejects.toMatchObject({
      code: 'DUPLICATE_REVIEW',
      matches: [
        { organizationId: 'org-parent', canonicalName: 'Parent Group', matchedOn: ['domain'] },
      ],
    })
    expect(tx.prospectOrganization.create).not.toHaveBeenCalled()
  })

  it('stops on an exact contact-address match', async () => {
    const { client } = createClient([
      {
        id: 'org-existing',
        canonicalName: 'Another Name',
        normalizedName: 'another name',
        normalizedDomain: 'another.test',
        contacts: [{ id: 'contact-1' }],
      },
    ])
    await expect(createProspectForOperatorAction(input, client as never)).rejects.toMatchObject({
      code: 'DUPLICATE_REVIEW',
      matches: [{ organizationId: 'org-existing', matchedOn: ['email'] }],
    })
  })

  it('refuses an address that is blocked anywhere in the CRM', async () => {
    const { tx, client } = createClient([], true)
    await expect(createProspectForOperatorAction(input, client as never)).rejects.toMatchObject({
      code: 'SUPPRESSED',
    })
    expect(tx.prospectOrganization.create).not.toHaveBeenCalled()
  })

  it('creates once and a repeat of the same job replays instead of duplicating', async () => {
    const { tx, client } = createClient()
    const first = await createProspectForOperatorAction(input, client as never)
    expect(first).toMatchObject({ organizationId: 'org-new', replayed: false })
    expect(tx.prospectOrganization.create).toHaveBeenCalledTimes(1)
    // The receipt rides on the creation activity.
    expect(
      tx.prospectActivity.create.mock.calls.some(
        (call) => call[0].data.externalReceiptKey === 'operator:op-create:prospect-create',
      ),
    ).toBe(true)

    const second = await createProspectForOperatorAction(input, client as never)
    expect(second).toMatchObject({ organizationId: 'org-new', replayed: true })
    expect(tx.prospectOrganization.create).toHaveBeenCalledTimes(1)
    expect(tx.prospectContact.create).toHaveBeenCalledTimes(1)
  })

  it('creates CRM records only: no customer or tenant table is touched', async () => {
    const { tx, client } = createClient()
    await createProspectForOperatorAction(input, client as never)
    expect(Object.keys(tx).sort()).toEqual(
      [
        'auditLog',
        'prospectActivity',
        'prospectContact',
        'prospectContactSuppressionEvent',
        'prospectOrganization',
        'prospectOrganizationTag',
        'prospectTag',
        'prospectVenue',
      ].sort(),
    )
  })

  it('rejects a name-less or invalid-address request before searching', async () => {
    const { tx, client } = createClient()
    await expect(
      createProspectForOperatorAction(
        { ...input, organization: { canonicalName: '  ' } },
        client as never,
      ),
    ).rejects.toBeInstanceOf(ProspectActionError)
    await expect(
      createProspectForOperatorAction(
        { ...input, contact: { fullName: 'Sam', email: 'nope' } },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.prospectOrganization.create).not.toHaveBeenCalled()
  })
})
