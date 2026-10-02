/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed fakes for the database and the grant */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateProspectAccountAction: vi.fn(),
  changeProspectContactAddressAction: vi.fn(),
  createProspectForOperatorAction: vi.fn(),
  approveProspectImportAction: vi.fn(),
  enqueueProspectImportCommit: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  updateProspectAccountAction: mocks.updateProspectAccountAction,
  changeProspectContactAddressAction: mocks.changeProspectContactAddressAction,
  createProspectForOperatorAction: mocks.createProspectForOperatorAction,
  approveProspectImportAction: mocks.approveProspectImportAction,
}))
vi.mock('@pathfinder/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/jobs')>()),
  enqueueProspectImportCommit: mocks.enqueueProspectImportCommit,
}))

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { computeImportPlan } from '../crm-import-plan'
import { OperatorNotFoundError } from '../grants'
import {
  approveAndApplyProposal,
  createKindRegistry,
  OperatorStaleError,
  proposalView,
} from '../proposals'
import {
  crmAccountUpdateKind,
  crmContactAddressChangeKind,
  crmImportCommitKind,
  crmProspectCreateKind,
} from './crm-prospect-admin'

const OPERATION_ID = '3f2b8a52-6c1e-4f5e-9d8a-1b2c3d4e5f60'
const NOW = new Date('2026-10-02T00:00:00.000Z')
const grant = { grantId: 'g', clientId: 'c', userId: 'user_owner' } as any
const actor = { type: 'HUMAN', id: 'user_owner', role: 'PLATFORM_ADMIN' } as const

const ctx = (database: any) => ({ database, grant, now: NOW }) as any
const applyCtx = (database: any) =>
  ({ ...ctx(database), actor, proposalId: 'p1', operationId: OPERATION_ID }) as any

beforeEach(() => vi.resetAllMocks())

// ---------------------------------------------------------------------------
// Contract: account update input
// ---------------------------------------------------------------------------

describe('crm.propose_account_update input', () => {
  const base = {
    organizationId: 'org-1',
    expectedVersion: 4,
    reason: 'Corrected',
    operationId: OPERATION_ID,
  }
  const parse = (extra: Record<string, unknown>) =>
    OPERATOR_MCP_INPUTS['crm.propose_account_update'].safeParse({ ...base, ...extra })

  it('rejects an unsupported field instead of ignoring it', () => {
    for (const field of [
      { stage: 'WON' },
      { priority: 'HIGH' },
      { relationshipTier: 'STRATEGIC' },
      { archived: true },
      { email: 'a@example.test' },
      { notes: 'x' },
      { normalizedName: 'x' },
    ]) {
      const result = parse({ name: 'X', ...field })
      expect(result.success, JSON.stringify(field)).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true)
      }
    }
  })

  it('needs at least one field to change', () => {
    expect(parse({}).success).toBe(false)
  })

  it('keeps omitted and null apart, and allows null only where clearing is allowed', () => {
    const cleared = parse({ website: null, city: null, owner: null, type: null })
    expect(cleared.success).toBe(true)
    if (cleared.success) {
      expect(cleared.data.website).toBeNull()
      expect(cleared.data.owner).toBeNull()
      expect('region' in cleared.data).toBe(false)
      expect(cleared.data.region).toBeUndefined()
    }
    expect(parse({ name: null }).success).toBe(false)
    expect(parse({ aliases: null, name: 'X' }).success).toBe(false)
    expect(parse({ tags: null, name: 'X' }).success).toBe(false)
    // A whole-list clear is an empty list, not a null.
    expect(parse({ aliases: [], tags: [] }).success).toBe(true)
  })

  it('names the owner by exactly one of userId or email', () => {
    expect(parse({ owner: { userId: 'user_a' } }).success).toBe(true)
    expect(parse({ owner: { email: 'a@example.test' } }).success).toBe(true)
    expect(parse({ owner: { userId: 'user_a', email: 'a@example.test' } }).success).toBe(false)
    expect(parse({ owner: {} }).success).toBe(false)
    expect(parse({ owner: { name: 'Pat' } }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Account update kind
// ---------------------------------------------------------------------------

const accountView = {
  organizationId: 'org-1',
  name: 'Example Museum',
  website: 'https://example-museum.test',
  domain: 'example-museum.test',
  aliases: [],
  organizationType: 'Museum',
  city: 'Sampleton',
  region: null,
  country: null,
  tags: [],
  ownerId: null,
  archived: false,
  updatedAt: '2026-09-01T00:00:00.000Z',
  version: 6,
}

function accountDatabase(overrides: Record<string, unknown> = {}) {
  const view = { ...accountView, ...overrides }
  return {
    prospectOrganization: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'org-1',
        canonicalName: view.name,
        website: view.website,
        normalizedDomain: view.domain,
        aliases: view.aliases,
        organizationType: view.organizationType,
        headquartersCity: view.city,
        headquartersRegion: view.region,
        headquartersCountry: view.country,
        archivedAt: view.archived ? new Date() : null,
        updatedAt: new Date(view.updatedAt),
        opportunity: { id: 'o', ownerId: view.ownerId, updatedAt: new Date(view.updatedAt) },
        tagAssignments: [],
      }),
    },
    prospectActivity: { count: vi.fn().mockResolvedValue((view.version as number) - 1) },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  }
}

describe('crm.account-update kind', () => {
  const args = (extra: Record<string, unknown> = {}) =>
    crmAccountUpdateKind.parse({
      organizationId: 'org-1',
      expectedVersion: 6,
      reason: 'Corrected city',
      city: 'Newtown',
      operationId: OPERATION_ID,
      ...extra,
    })

  it('accepts the current version', async () => {
    await expect(
      crmAccountUpdateKind.authorize!(args(), ctx(accountDatabase())),
    ).resolves.toBeUndefined()
  })

  it('rejects a stale version and returns the account as it is now', async () => {
    const stale = args({ expectedVersion: 5 })
    const attempt = crmAccountUpdateKind.authorize!(stale, ctx(accountDatabase()))
    await expect(attempt).rejects.toBeInstanceOf(OperatorStaleError)
    await expect(attempt).rejects.toMatchObject({
      code: 'STALE',
      details: { organizationId: 'org-1', name: 'Example Museum', version: 6, city: 'Sampleton' },
    })
  })

  it('rejects a stale updatedAt guard with the current account', async () => {
    const stale = args({ expectedUpdatedAt: '2026-08-01T00:00:00.000Z' })
    await expect(
      crmAccountUpdateKind.authorize!(stale, ctx(accountDatabase())),
    ).rejects.toMatchObject({ code: 'STALE', details: { updatedAt: '2026-09-01T00:00:00.000Z' } })
  })

  it('treats an archived or missing account as not found', async () => {
    await expect(
      crmAccountUpdateKind.authorize!(args(), ctx(accountDatabase({ archived: true }))),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
  })

  it('resolves the owner through the directory and refuses one it cannot find', async () => {
    const database = accountDatabase()
    await expect(
      crmAccountUpdateKind.authorize!(
        args({ owner: { email: 'nobody@example.test' } }),
        ctx(database),
      ),
    ).rejects.toMatchObject({ code: 'OWNER_NOT_FOUND' })
    expect(database.user.findFirst).toHaveBeenCalledTimes(1)

    database.user.findUnique.mockResolvedValue({
      id: 'user_b',
      email: 'b@example.test',
      fullName: null,
    })
    mocks.updateProspectAccountAction.mockResolvedValue({
      account: accountView,
      changes: [{ field: 'ownerId', from: null, to: 'user_b' }],
      replayed: false,
    })
    await crmAccountUpdateKind.apply(args({ owner: { userId: 'user_b' } }), applyCtx(database))
    expect(mocks.updateProspectAccountAction.mock.calls[0]![0].ownerId).toBe('user_b')
  })

  it('passes only what was named: omitted stays undefined, null stays null', async () => {
    mocks.updateProspectAccountAction.mockResolvedValue({
      account: accountView,
      changes: [{ field: 'website', from: 'https://example-museum.test', to: null }],
      replayed: false,
    })
    const out = await crmAccountUpdateKind.apply(
      crmAccountUpdateKind.parse({
        organizationId: 'org-1',
        expectedVersion: 6,
        reason: 'No site any more',
        website: null,
        operationId: OPERATION_ID,
      }),
      applyCtx(accountDatabase()),
    )
    const call = mocks.updateProspectAccountAction.mock.calls[0]![0]
    expect(call.website).toBeNull()
    for (const omitted of [
      'name',
      'aliases',
      'organizationType',
      'city',
      'region',
      'country',
      'tags',
      'ownerId',
    ]) {
      expect(call).not.toHaveProperty(omitted)
    }
    expect(call.operationKey).toBe(OPERATION_ID)
    // The result is the canonical object and the exact changed fields.
    expect(out.result.changedFields).toEqual(['website'])
    expect(out.result.account).toMatchObject({ organizationId: 'org-1', version: 6 })
  })

  it('turns a lost compare-and-swap into a stale refusal carrying the current account', async () => {
    const { ProspectActionError } = await import('@pathfinder/db')
    mocks.updateProspectAccountAction.mockRejectedValue(
      new ProspectActionError('CONFLICT', 'The account changed since it was read'),
    )
    await expect(
      crmAccountUpdateKind.apply(args(), applyCtx(accountDatabase())),
    ).rejects.toMatchObject({ code: 'STALE', details: { organizationId: 'org-1' } })
  })

  it('reconciles from the receipt: none means not applied, a receipt means applied', async () => {
    const database: any = accountDatabase()
    database.prospectActivity.findUnique = vi.fn().mockResolvedValue(null)
    await expect(crmAccountUpdateKind.reconcile!(args(), applyCtx(database))).resolves.toEqual({
      state: 'not_applied',
    })
    expect(database.prospectActivity.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalReceiptKey: `operator:${OPERATION_ID}:account-update` },
      }),
    )
    database.prospectActivity.findUnique.mockResolvedValue({
      evidence: { changes: [{ field: 'city', from: 'Sampleton', to: 'Newtown' }] },
    })
    const verdict: any = await crmAccountUpdateKind.reconcile!(args(), applyCtx(database))
    expect(verdict.state).toBe('applied')
    expect(verdict.outcome.result.changedFields).toEqual(['city'])
  })

  it('describes every field it will change, including clears', () => {
    const lines = crmAccountUpdateKind.describe(
      args({ website: null, tags: [], owner: null }),
    ).lines
    expect(lines).toEqual(
      expect.arrayContaining([
        'website → cleared',
        'tags → cleared',
        'owner → cleared',
        'city → Newtown',
      ]),
    )
  })
})

describe('proposalView for a stale refusal', () => {
  it('shows the current state the refusal carried', () => {
    const view = proposalView(
      {
        id: 'p1',
        status: 'STALE',
        argsHash: 'a'.repeat(64),
        planId: null,
        failureCode: 'TARGET_CHANGED',
        result: { current: { organizationId: 'org-1', version: 6 } },
      } as any,
      {} as any,
    )
    expect(view.result).toEqual({
      failureCode: 'TARGET_CHANGED',
      current: { organizationId: 'org-1', version: 6 },
    })
  })
})

// ---------------------------------------------------------------------------
// Contact address change kind
// ---------------------------------------------------------------------------

const CONTACT_AT = new Date('2026-09-02T00:00:00.000Z')

function contactDatabase(overrides: Record<string, unknown> = {}, blocked = false) {
  return {
    prospectContact: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'contact-1',
        organizationId: 'org-1',
        archivedAt: null,
        updatedAt: CONTACT_AT,
        doNotContact: false,
        unsubscribedAt: null,
        complainedAt: null,
        permissionState: 'VERIFIED',
        suppressedAt: null,
        lastHardBounceAt: null,
        organization: { archivedAt: null, opportunity: { stage: 'CONTACTED' } },
        ...overrides,
      }),
      findFirst: vi.fn().mockResolvedValue(blocked ? { id: 'blocked' } : null),
    },
  }
}

describe('crm.contact-address-change kind', () => {
  const args = (extra: Record<string, unknown> = {}) =>
    crmContactAddressChangeKind.parse({
      contactId: 'contact-1',
      expectedUpdatedAt: CONTACT_AT.toISOString(),
      newEmail: 'New@Example.test',
      reason: 'Moved',
      operationId: OPERATION_ID,
      ...extra,
    })

  it('defaults to retiring the old address and normalizes the new one', () => {
    const parsed = args()
    expect(parsed.retireOldAddress).toBe(true)
    expect(parsed.newEmail).toBe('new@example.test')
  })

  it('refuses a stale contact with its current updatedAt', async () => {
    const stale = args({ expectedUpdatedAt: '2026-08-01T00:00:00.000Z' })
    await expect(
      crmContactAddressChangeKind.authorize!(stale, ctx(contactDatabase())),
    ).rejects.toMatchObject({ code: 'STALE', details: { updatedAt: CONTACT_AT.toISOString() } })
  })

  it('never proposes around a suppression', async () => {
    for (const overrides of [
      { unsubscribedAt: new Date() },
      { doNotContact: true },
      { organization: { archivedAt: null, opportunity: { stage: 'DO_NOT_CONTACT' } } },
    ]) {
      await expect(
        crmContactAddressChangeKind.authorize!(args(), ctx(contactDatabase(overrides))),
      ).rejects.toMatchObject({ code: 'DO_NOT_CONTACT_LOCKED' })
    }
    await expect(
      crmContactAddressChangeKind.authorize!(args(), ctx(contactDatabase({}, true))),
    ).rejects.toMatchObject({ code: 'ADDRESS_SUPPRESSED' })
  })

  it('passes the guard and the retire flag to the canonical action and reports the old row kept', async () => {
    mocks.changeProspectContactAddressAction.mockResolvedValue({
      newContact: { id: 'contact-2', updatedAt: NOW },
      oldContact: { archivedAt: NOW },
      replayed: false,
    })
    const out = await crmContactAddressChangeKind.apply(args(), applyCtx(contactDatabase()))
    expect(mocks.changeProspectContactAddressAction.mock.calls[0]![0]).toMatchObject({
      contactId: 'contact-1',
      expectedUpdatedAt: CONTACT_AT,
      newEmail: 'new@example.test',
      retireOldAddress: true,
      operationKey: OPERATION_ID,
    })
    expect(out.result).toMatchObject({
      newContactId: 'contact-2',
      oldContactId: 'contact-1',
      oldContactArchived: true,
      oldHistoryAndSuppressionKept: true,
    })
  })

  it('describes that history and blocks stay on the old address', () => {
    expect(crmContactAddressChangeKind.describe(args()).lines.join(' ')).toMatch(
      /history and any block stay on it/u,
    )
  })
})

// ---------------------------------------------------------------------------
// Prospect create kind
// ---------------------------------------------------------------------------

function createDatabase(matches: any[] = [], blocked = false) {
  return {
    prospectOrganization: { findMany: vi.fn().mockResolvedValue(matches) },
    prospectContact: { findFirst: vi.fn().mockResolvedValue(blocked ? { id: 'b' } : null) },
    prospectActivity: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
  }
}

describe('crm.prospect-create kind', () => {
  const args = (extra: Record<string, unknown> = {}) =>
    crmProspectCreateKind.parse({
      organization: { name: 'Example Museum', website: 'https://example-museum.test' },
      contact: { fullName: 'Sam Example', email: 'sam@example-museum.test' },
      source: 'conference list',
      operationId: OPERATION_ID,
      ...extra,
    })

  it('stops for review on an exact name, domain or address match and lists the matches', async () => {
    const database = createDatabase([
      {
        id: 'org-9',
        canonicalName: 'Parent Group',
        normalizedName: 'parent group',
        normalizedDomain: 'example-museum.test',
      },
    ])
    const attempt = crmProspectCreateKind.authorize!(args(), ctx(database))
    await expect(attempt).rejects.toMatchObject({
      code: 'DUPLICATE_REVIEW',
      details: { matches: [{ organizationId: 'org-9', matchedOn: ['domain'] }] },
    })
    // It searched with the same normalized identity the admin action uses.
    expect(database.prospectOrganization.findMany.mock.calls[0]![0].where.OR).toEqual(
      expect.arrayContaining([
        { normalizedName: 'example museum' },
        { normalizedDomain: 'example-museum.test' },
        { contacts: { some: { normalizedEmail: 'sam@example-museum.test' } } },
      ]),
    )
    expect(mocks.createProspectForOperatorAction).not.toHaveBeenCalled()
  })

  it('refuses an address blocked anywhere', async () => {
    await expect(
      crmProspectCreateKind.authorize!(args(), ctx(createDatabase([], true))),
    ).rejects.toMatchObject({ code: 'ADDRESS_SUPPRESSED' })
  })

  it('passes with no match and applies through the canonical create with the operation as the receipt', async () => {
    const database = createDatabase()
    await expect(crmProspectCreateKind.authorize!(args(), ctx(database))).resolves.toBeUndefined()
    mocks.createProspectForOperatorAction.mockResolvedValue({
      organizationId: 'org-new',
      venueId: null,
      contactId: 'contact-new',
      replayed: false,
    })
    const out = await crmProspectCreateKind.apply(args(), applyCtx(database))
    const call = mocks.createProspectForOperatorAction.mock.calls[0]![0]
    expect(call.operationKey).toBe(OPERATION_ID)
    expect(call.organization.canonicalName).toBe('Example Museum')
    expect(call.contact.email).toBe('sam@example-museum.test')
    expect(out.result).toMatchObject({ organizationId: 'org-new', customerCreated: false })
  })

  it('a repeat of the same job reports a replay, not a second record', async () => {
    mocks.createProspectForOperatorAction.mockResolvedValue({
      organizationId: 'org-new',
      venueId: null,
      contactId: null,
      replayed: true,
    })
    const out = await crmProspectCreateKind.apply(args(), applyCtx(createDatabase()))
    expect(out.result.replayed).toBe(true)
  })

  it('settles an interrupted apply from the receipt', async () => {
    const database: any = createDatabase()
    await expect(crmProspectCreateKind.reconcile!(args(), applyCtx(database))).resolves.toEqual({
      state: 'not_applied',
    })
    database.prospectActivity.findUnique.mockResolvedValue({
      organizationId: 'org-new',
      venueId: null,
      contactId: null,
    })
    const verdict: any = await crmProspectCreateKind.reconcile!(args(), applyCtx(database))
    expect(verdict.state).toBe('applied')
    expect(verdict.outcome.result.organizationId).toBe('org-new')
  })

  it('has no way to name a customer, tenant or outreach field', () => {
    for (const extra of [
      { tenantId: 't1' },
      { customer: true },
      { stage: 'WON' },
      { organization: { name: 'X', tenantId: 't1' } },
    ]) {
      expect(
        OPERATOR_MCP_INPUTS['crm.propose_prospect_create'].safeParse({
          organization: { name: 'X' },
          source: 'list',
          operationId: OPERATION_ID,
          ...extra,
        }).success,
      ).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Import plan and commit kind
// ---------------------------------------------------------------------------

type FakeRow = {
  id: string
  rowFingerprint: string
  status: string
  decision: string | null
  targetOrganizationId: string | null
  targetVenueId: string | null
  targetContactId: string | null
}

function fakeRow(n: number, status: string, decision: string | null = null): FakeRow {
  return {
    id: `row-${String(n).padStart(3, '0')}`,
    rowFingerprint: String(n).padStart(64, '0'),
    status,
    decision,
    targetOrganizationId: null,
    targetVenueId: null,
    targetContactId: null,
  }
}

function importDatabase(rows: FakeRow[], importOverrides: Record<string, unknown> = {}) {
  const record = {
    id: 'import-1',
    status: 'DRY_RUN_READY',
    fileHash: 'f'.repeat(64),
    mappingHash: 'e'.repeat(64),
    progressCursor: null,
    sourceObjectKey: null,
    approvedAt: null,
    ...importOverrides,
  }
  return {
    record,
    database: {
      prospectImport: { findUnique: vi.fn().mockResolvedValue(record) },
      prospectImportRow: {
        findMany: vi.fn().mockImplementation(({ cursor, take }: any) => {
          const start = cursor ? rows.findIndex((row) => row.id === cursor.id) + 1 : 0
          return Promise.resolve(rows.slice(start, start + take))
        }),
        groupBy: vi.fn().mockImplementation(() => {
          const counts = new Map<string, number>()
          for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
          return Promise.resolve(
            [...counts].map(([status, n]) => ({ status, _count: { _all: n } })),
          )
        }),
      },
    } as any,
  }
}

describe('import plan hash', () => {
  const sample = [fakeRow(1, 'VALID'), fakeRow(2, 'WARNING'), fakeRow(3, 'SKIPPED')]
  const identity = { id: 'import-1', fileHash: 'f'.repeat(64), mappingHash: 'e'.repeat(64) }

  it('is stable, counts every row, and changes when a row or a decision changes', async () => {
    const first = await computeImportPlan(importDatabase(sample).database, identity)
    const again = await computeImportPlan(importDatabase(sample).database, identity)
    expect(again.planHash).toBe(first.planHash)
    expect(first.rowTotal).toBe(3)
    expect(first.importableRows).toBe(2)
    expect(Object.values(first.counts).reduce((a, b) => a + b, 0)).toBe(first.rowTotal)

    const decided = await computeImportPlan(
      importDatabase([
        fakeRow(1, 'VALID'),
        fakeRow(2, 'WARNING', 'CREATE_DISTINCT'),
        fakeRow(3, 'SKIPPED'),
      ]).database,
      identity,
    )
    expect(decided.planHash).not.toBe(first.planHash)
    const otherFile = await computeImportPlan(importDatabase(sample).database, {
      ...identity,
      fileHash: 'a'.repeat(64),
    })
    expect(otherFile.planHash).not.toBe(first.planHash)
  })

  it('pages through more rows than one batch', async () => {
    const many = Array.from({ length: 2_300 }, (_, index) => fakeRow(index + 1, 'VALID'))
    const { database } = importDatabase(many)
    const plan = await computeImportPlan(database, identity)
    expect(plan.rowTotal).toBe(2_300)
    expect(database.prospectImportRow.findMany.mock.calls.length).toBeGreaterThan(2)
  })
})

describe('crm.import-commit kind', () => {
  const rows = [fakeRow(1, 'VALID'), fakeRow(2, 'WARNING'), fakeRow(3, 'SKIPPED')]
  const identity = { id: 'import-1', fileHash: 'f'.repeat(64), mappingHash: 'e'.repeat(64) }

  async function boundArgs(database: any, extra: Record<string, unknown> = {}) {
    const plan = await computeImportPlan(database, identity)
    return crmImportCommitKind.parse({
      importId: 'import-1',
      fileHash: 'f'.repeat(64),
      mappingHash: 'e'.repeat(64),
      planHash: plan.planHash,
      expectedRows: plan.importableRows,
      operationId: OPERATION_ID,
      ...extra,
    })
  }

  it('accepts an import whose file, mapping and rows match what was read', async () => {
    const { database } = importDatabase(rows)
    await expect(
      crmImportCommitKind.authorize!(await boundArgs(database), ctx(database)),
    ).resolves.toBeUndefined()
    expect(await crmImportCommitKind.targetVersion(await boundArgs(database), ctx(database))).toBe(
      (await boundArgs(database)).planHash,
    )
  })

  it('goes stale, with the current import, when the file, mapping or rows differ', async () => {
    const { database } = importDatabase(rows)
    const good = await boundArgs(database)
    for (const drift of [
      { fileHash: 'a'.repeat(64) },
      { mappingHash: 'b'.repeat(64) },
      { planHash: 'c'.repeat(64) },
      { expectedRows: 7 },
    ]) {
      const attempt = crmImportCommitKind.authorize!({ ...good, ...drift }, ctx(database))
      await expect(attempt).rejects.toBeInstanceOf(OperatorStaleError)
      await expect(attempt).rejects.toMatchObject({
        details: { importId: 'import-1', importableRows: 2 },
      })
    }
  })

  it('stops while duplicate rows still await a decision', async () => {
    const pending = [fakeRow(1, 'VALID'), fakeRow(2, 'DUPLICATE_REVIEW')]
    const { database } = importDatabase(pending)
    await expect(
      crmImportCommitKind.authorize!(await boundArgs(database), ctx(database)),
    ).rejects.toMatchObject({
      code: 'IMPORT_NOT_READY',
      details: { counts: { DUPLICATE_REVIEW: 1 } },
    })
  })

  it('refuses an import that is not staged or already finished', async () => {
    for (const status of ['DRAFT', 'COMPLETE', 'CANCELLED', 'PROCESSING']) {
      const { database } = importDatabase(rows, { status })
      await expect(
        crmImportCommitKind.authorize!(await boundArgs(database), ctx(database)),
      ).rejects.toMatchObject({ code: 'IMPORT_NOT_READY' })
    }
    const unfinished = importDatabase(rows, { sourceObjectKey: 'k', progressCursor: 'MAPPED' })
    await expect(
      crmImportCommitKind.authorize!(
        await boundArgs(unfinished.database),
        ctx(unfinished.database),
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_NOT_READY' })
  })

  it('treats an unknown import as not found', async () => {
    const { database } = importDatabase(rows)
    database.prospectImport.findUnique.mockResolvedValue(null)
    await expect(
      crmImportCommitKind.authorize!(
        crmImportCommitKind.parse({
          importId: 'nope',
          fileHash: 'f'.repeat(64),
          mappingHash: 'e'.repeat(64),
          planHash: 'c'.repeat(64),
          expectedRows: 1,
          operationId: OPERATION_ID,
        }),
        ctx(database),
      ),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
  })

  it('signs off through the existing admin service and queues the existing job once', async () => {
    const { database } = importDatabase(rows)
    mocks.approveProspectImportAction.mockResolvedValue({
      prospectImport: { status: 'APPROVED' },
      replayed: false,
    })
    const out = await crmImportCommitKind.apply(await boundArgs(database), applyCtx(database))
    expect(mocks.approveProspectImportAction).toHaveBeenCalledWith(
      { importId: 'import-1', actor },
      database,
    )
    expect(mocks.enqueueProspectImportCommit).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueProspectImportCommit).toHaveBeenCalledWith({ importId: 'import-1' })
    expect(out.result).toMatchObject({ importId: 'import-1', status: 'APPROVED', queued: true })
  })

  it('settles an interrupted apply from the import state', async () => {
    for (const [status, expected] of [
      ['DRY_RUN_READY', 'not_applied'],
      ['APPROVED', 'not_applied'],
    ] as const) {
      const { database } = importDatabase(rows, { status })
      const verdict: any = await crmImportCommitKind.reconcile!(
        await boundArgs(importDatabase(rows).database),
        applyCtx(database),
      )
      expect(verdict.state).toBe(expected)
    }
    const started = importDatabase(rows, { status: 'PROCESSING', approvedAt: NOW })
    const verdict: any = await crmImportCommitKind.reconcile!(
      await boundArgs(importDatabase(rows).database),
      applyCtx(started.database),
    )
    expect(verdict.state).toBe('applied')
    const other = importDatabase(rows, { status: 'CANCELLED' })
    await expect(
      crmImportCommitKind.reconcile!(
        await boundArgs(importDatabase(rows).database),
        applyCtx(other.database),
      ),
    ).resolves.toEqual({ state: 'unknown' })
  })

  it('is always-ask: it appears in the contract list', async () => {
    const { OPERATOR_ALWAYS_ASK_TOOLS } = await import('@pathfinder/contracts/operator-mcp')
    expect(OPERATOR_ALWAYS_ASK_TOOLS).toEqual(
      expect.arrayContaining(['crm.propose_import_commit', 'crm.propose_contact_address_change']),
    )
  })
})

// ---------------------------------------------------------------------------
// Approval replay
// ---------------------------------------------------------------------------

describe('approval replay', () => {
  it('a second approval of an applied proposal returns it untouched and applies nothing again', async () => {
    const apply = vi.fn()
    const spyKind = { ...crmProspectCreateKind, apply }
    const row = {
      id: 'p1',
      status: 'APPLIED',
      planId: null,
      argsHash: 'a'.repeat(64),
      result: { organizationId: 'org-new' },
    }
    const database: any = {
      operatorProposal: {
        findUnique: vi.fn().mockResolvedValue(row),
        updateMany: vi.fn(),
      },
    }
    const out = await approveAndApplyProposal(
      {
        proposalId: 'p1',
        argsHash: row.argsHash,
        actorUserId: 'user_owner',
        requestId: 'r1',
        now: NOW,
      },
      { database, kinds: createKindRegistry([spyKind]), allowedUserIds: new Set(['user_owner']) },
    )
    expect(out).toBe(row)
    expect(apply).not.toHaveBeenCalled()
    expect(database.operatorProposal.updateMany).not.toHaveBeenCalled()
    expect(mocks.createProspectForOperatorAction).not.toHaveBeenCalled()
  })

  it('a replay with the wrong argsHash does not approve a pending proposal', async () => {
    const row = {
      id: 'p2',
      status: 'PENDING',
      planId: null,
      argsHash: 'a'.repeat(64),
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    }
    const database: any = {
      operatorProposal: { findUnique: vi.fn().mockResolvedValue(row), updateMany: vi.fn() },
    }
    await expect(
      approveAndApplyProposal(
        {
          proposalId: 'p2',
          argsHash: 'b'.repeat(64),
          actorUserId: 'user_owner',
          requestId: 'r1',
          now: NOW,
        },
        {
          database,
          kinds: createKindRegistry([crmImportCommitKind]),
          allowedUserIds: new Set(['user_owner']),
        },
      ),
    ).rejects.toMatchObject({ code: 'ARGS_HASH_MISMATCH' })
    expect(database.operatorProposal.updateMany).not.toHaveBeenCalled()
  })
})
