/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed fakes for the database */
import { describe, expect, it, vi } from 'vitest'

import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorContactView, type SnapshotContactInput } from '../crm-projection'
import { OperatorNotFoundError } from '../grants'
import { crmAccountReadTools } from './crm-accounts'
import { crmImportReadTools } from './crm-imports'
import { OperatorInvalidCursorError } from './page'

const tool = (tools: readonly any[], name: string) => tools.find((entry) => entry.name === name)!
const getImport = tool(crmImportReadTools, 'crm.get_import')
const listImports = tool(crmImportReadTools, 'crm.list_imports')
const getNote = tool(crmAccountReadTools, 'crm.get_note')

const at = (n: number) => new Date(Date.UTC(2026, 8, n))

function row(n: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: `row-${String(n).padStart(3, '0')}`,
    sheetName: 'Data',
    originalRowNumber: n + 1,
    rowFingerprint: String(n).padStart(64, '0'),
    status,
    decision: null,
    warnings: [],
    errors: [],
    duplicateMatches: [],
    errorCode: null,
    importedOrganizationId: null,
    importedVenueId: null,
    importedContactId: null,
    processedAt: null,
    targetOrganizationId: null,
    targetVenueId: null,
    targetContactId: null,
    ...extra,
  }
}

function importFake(rows: any[], overrides: Record<string, unknown> = {}) {
  const record = {
    id: 'import-1',
    fileName: 'prospects.xlsx',
    fileType: 'xlsx',
    fileSize: 1234,
    fileHash: 'f'.repeat(64),
    mappingHash: 'e'.repeat(64),
    packageSchemaVersion: null,
    status: 'DRY_RUN_READY',
    totalRows: rows.length,
    importedRows: 0,
    failedRows: 0,
    duplicateRows: 0,
    validRows: 0,
    warningRows: 0,
    createdAt: at(1),
    approvedAt: null,
    completedAt: null,
    sheets: [{ sheetName: 'Data', detectedRows: rows.length, selected: true }],
    ...overrides,
  }
  const matches = (where: any, entry: any) => !where?.status || entry.status === where.status
  return {
    prospectImport: {
      findUnique: vi.fn().mockResolvedValue(record),
      findFirst: vi.fn().mockResolvedValue({ id: 'import-1' }),
      findMany: vi.fn().mockResolvedValue([record]),
    },
    prospectImportRow: {
      findFirst: vi.fn().mockImplementation(({ where }: any) => {
        const id = where.AND?.[1]?.id
        return Promise.resolve(rows.find((entry) => entry.id === id) ?? null)
      }),
      findMany: vi.fn().mockImplementation(({ where, cursor, take }: any) => {
        const filtered = rows.filter((entry) => matches(where, entry))
        const start = cursor ? filtered.findIndex((entry) => entry.id === cursor.id) + 1 : 0
        return Promise.resolve(filtered.slice(start, start + take))
      }),
      groupBy: vi.fn().mockImplementation(() => {
        const counts = new Map<string, number>()
        for (const entry of rows) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1)
        return Promise.resolve([...counts].map(([status, n]) => ({ status, _count: { _all: n } })))
      }),
    },
  } as any
}

const run = (handler: any, args: unknown, database: any) =>
  handler.handler(args, { database, grant: {}, now: new Date() })

describe('crm.get_import', () => {
  const rows = [
    row(1, 'IMPORTED', {
      importedOrganizationId: 'org-1',
      importedVenueId: 'venue-1',
      importedContactId: 'contact-1',
      processedAt: at(2),
    }),
    row(2, 'WARNING', { warnings: ['website-missing', 'formula-like-text'] }),
    row(3, 'FAILED', { errors: ['invalid-character'], errorCode: 'UNEXPECTED' }),
    row(4, 'SKIPPED', { decision: 'SKIP' }),
    row(5, 'DUPLICATE_REVIEW', {
      duplicateMatches: [
        {
          organizationId: 'org-9',
          canonicalName: 'Other Museum',
          confidence: 0.9,
          reasons: ['domain'],
        },
      ],
    }),
    row(6, 'QUARANTINED'),
    row(7, 'VALID'),
  ]

  it('reconciles every disposition to the recorded total and matches its own output contract', async () => {
    const out = await run(getImport, { importId: 'import-1' }, importFake(rows))
    expect(OPERATOR_MCP_OUTPUTS['crm.get_import'].safeParse(out).success).toBe(true)
    const { counts, rowTotal, reconciled } = out.dispositions
    expect(Object.values(counts).reduce((a: number, b: any) => a + b, 0)).toBe(rowTotal)
    expect(rowTotal).toBe(7)
    expect(reconciled).toBe(true)
    expect(counts).toMatchObject({
      IMPORTED: 1,
      WARNING: 1,
      FAILED: 1,
      SKIPPED: 1,
      DUPLICATE_REVIEW: 1,
      QUARANTINED: 1,
      VALID: 1,
    })
    expect(out.import.importableRows).toBe(2)
    expect(out.import.planHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(out.import.fileHash).toBe('f'.repeat(64))
    expect(out.import.mappingHash).toBe('e'.repeat(64))
  })

  it('says so when the rows do not add up to the recorded total', async () => {
    const out = await run(getImport, { importId: 'import-1' }, importFake(rows, { totalRows: 9 }))
    expect(out.dispositions.rowTotal).toBe(7)
    expect(out.dispositions.reconciled).toBe(false)
  })

  it('returns source mail IDs and claimed states only as unverified import references', async () => {
    const source = row(1, 'IMPORTED', {
      normalizedValues: {
        gmailMessageId: 'gmail-message-example',
        gmailThreadId: 'gmail-thread-example',
        gmailDraftId: 'gmail-draft-example',
        claimedDeliveryState: 'DELIVERED',
        claimedDraftState: 'DRAFT',
        claimedRelationshipState: 'NOT_INTERESTED',
      },
    })
    const out = await run(getImport, { importId: 'import-1' }, importFake([source]))
    expect(OPERATOR_MCP_OUTPUTS['crm.get_import'].safeParse(out).success).toBe(true)
    expect(out.rows.items[0].importedReferences).toMatchObject({
      verification: 'UNVERIFIED_IMPORT',
      gmailMessageId: 'gmail-message-example',
      gmailThreadId: 'gmail-thread-example',
      gmailDraftId: 'gmail-draft-example',
      claimedDeliveryState: 'DELIVERED',
      claimedDraftState: 'DRAFT',
      claimedRelationshipState: 'NOT_INTERESTED',
    })
    expect(out.rows.items[0].receipt).toEqual({
      organizationId: null,
      venueId: null,
      contactId: null,
    })
  })

  it('returns per-row receipts with the canonical ids and the reason a row did not import', async () => {
    const out = await run(getImport, { importId: 'import-1', limit: 25 }, importFake(rows))
    const imported = out.rows.items.find((entry: any) => entry.status === 'IMPORTED')
    expect(imported.receipt).toEqual({
      organizationId: 'org-1',
      venueId: 'venue-1',
      contactId: 'contact-1',
    })
    const pending = out.rows.items.find((entry: any) => entry.status === 'WARNING')
    expect(pending.receipt).toEqual({ organizationId: null, venueId: null, contactId: null })
    expect(pending.warnings).toContain('formula-like-text')
    const failed = out.rows.items.find((entry: any) => entry.status === 'FAILED')
    expect(failed.errors).toEqual(['invalid-character'])
    const duplicate = out.rows.items.find((entry: any) => entry.status === 'DUPLICATE_REVIEW')
    expect(duplicate.duplicateMatches[0]).toMatchObject({
      organizationId: 'org-9',
      name: 'Other Museum',
    })
    // Source cell values are never returned.
    expect(JSON.stringify(out)).not.toContain('sourceValues')
  })

  it('pages rows with a cursor that must belong to this import and filter', async () => {
    const database = importFake(rows)
    const first = await run(getImport, { importId: 'import-1', limit: 3 }, database)
    expect(first.rows.items).toHaveLength(3)
    expect(first.rows.complete).toBe(false)
    const second = await run(
      getImport,
      { importId: 'import-1', limit: 3, cursor: first.rows.nextCursor },
      database,
    )
    expect(second.rows.items[0].rowId).toBe('row-004')
    await expect(
      run(getImport, { importId: 'import-1', cursor: 'row-of-another-import' }, database),
    ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
  })

  it('treats an unknown import as not found', async () => {
    const database = importFake(rows)
    database.prospectImport.findUnique.mockResolvedValue(null)
    await expect(run(getImport, { importId: 'nope' }, database)).rejects.toBeInstanceOf(
      OperatorNotFoundError,
    )
  })
})

describe('crm.list_imports', () => {
  it('lists summaries with hashes and totals and rejects a cursor outside the query', async () => {
    const database = importFake([row(1, 'VALID')])
    const out = await run(listImports, {}, database)
    expect(OPERATOR_MCP_OUTPUTS['crm.list_imports'].safeParse(out).success).toBe(true)
    expect(out.items[0]).toMatchObject({
      importId: 'import-1',
      fileHash: 'f'.repeat(64),
      mappingHash: 'e'.repeat(64),
      status: 'DRY_RUN_READY',
      totalRows: 1,
    })
    expect(out.complete).toBe(true)
    database.prospectImport.findFirst.mockResolvedValue(null)
    await expect(
      run(listImports, { cursor: `${at(1).toISOString()}|elsewhere` }, database),
    ).rejects.toBeInstanceOf(OperatorInvalidCursorError)
    await expect(run(listImports, { cursor: 'garbage' }, database)).rejects.toBeInstanceOf(
      OperatorInvalidCursorError,
    )
  })
})

describe('crm.get_note', () => {
  const long = `Legacy embedded note. ${'x'.repeat(2_000)} tail marker`
  const database = (overrides: Record<string, unknown> = {}) =>
    ({
      prospectOrganization: {
        findUnique: vi.fn().mockResolvedValue({ id: 'org-1', notes: long, ...overrides }),
      },
      prospectActivity: { findFirst: vi.fn().mockResolvedValue(null) },
      prospectContact: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
    }) as any

  it('returns the whole embedded note that other reads cut at 500 characters', async () => {
    const out = await run(getNote, { organizationId: 'org-1' }, database())
    expect(OPERATOR_MCP_OUTPUTS['crm.get_note'].safeParse(out).success).toBe(true)
    expect(out.source).toBe('embedded')
    expect(out.length).toBe(long.length)
    expect(out.text.text).toBe(long)
    expect(out.text.truncated).toBe(false)
    expect(out.text.untrusted).toBe(true)
    expect(out.text.text.endsWith('tail marker')).toBe(true)
  })

  it('withholds address-shaped strings like every other note read', async () => {
    const out = await run(
      getNote,
      { organizationId: 'org-1' },
      database({ notes: 'Call back sam@example.test tomorrow' }),
    )
    expect(out.text.text).toBe('Call back [address withheld] tomorrow')
  })

  it('reports no text for an account with no embedded note', async () => {
    const out = await run(getNote, { organizationId: 'org-1' }, database({ notes: null }))
    expect(out).toMatchObject({ text: null, length: 0, source: 'embedded' })
  })

  it('reads a recorded note in full by id, scoped to the account', async () => {
    const db = database()
    db.prospectActivity.findFirst.mockResolvedValue({
      id: 'note-1',
      occurredAt: at(3),
      detail: 'y'.repeat(900),
      summary: 'Operator note added',
    })
    const out = await run(getNote, { organizationId: 'org-1', noteId: 'note-1' }, db)
    expect(out.source).toBe('activity')
    expect(out.length).toBe(900)
    expect(db.prospectActivity.findFirst.mock.calls[0]![0].where).toMatchObject({
      id: 'note-1',
      organizationId: 'org-1',
    })
    db.prospectActivity.findFirst.mockResolvedValue(null)
    await expect(
      run(getNote, { organizationId: 'org-1', noteId: 'foreign' }, db),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
  })

  it('does not accept a note id and a contact id together', async () => {
    await expect(
      run(getNote, { organizationId: 'org-1', noteId: 'n', contactId: 'c' }, database()),
    ).rejects.toThrow()
  })

  it('keeps a suppressed contact note private', async () => {
    const db = database()
    const suppressed = {
      id: 'contact-1',
      notes: 'private words',
      email: 'gone@example.test',
      venueId: null,
      fullName: null,
      title: null,
      phone: null,
      emailReadiness: 'READY',
      permissionState: 'OPTED_OUT',
      doNotContact: false,
      suppressionReason: null,
      suppressedAt: null,
      unsubscribedAt: null,
      complainedAt: null,
      lastHardBounceAt: null,
    }
    db.prospectContact.findFirst.mockResolvedValue(suppressed)
    db.prospectContact.findMany.mockResolvedValue([suppressed])
    const out = await run(getNote, { organizationId: 'org-1', contactId: 'contact-1' }, db)
    expect(out.text).toBeNull()
    expect(JSON.stringify(out)).not.toContain('private words')
  })
})

describe('contact reads return phone with the same privacy as the address', () => {
  const contact: SnapshotContactInput = {
    id: 'c1',
    venueId: null,
    fullName: 'Sam Example',
    title: null,
    email: 'sam@example.test',
    phone: '+1 555 0100',
    emailReadiness: 'READY',
    permissionState: 'VERIFIED',
    doNotContact: false,
    suppressionReason: null,
    suppressedAt: null,
    unsubscribedAt: null,
    complainedAt: null,
    lastHardBounceAt: null,
  }

  it('shows the phone of a contactable person', () => {
    expect(operatorContactView(contact).phone).toBe('+1 555 0100')
  })

  it('withholds the phone with the address for a suppressed or blocked person', () => {
    expect(operatorContactView({ ...contact, unsubscribedAt: new Date() }).phone).toBeNull()
    expect(operatorContactView({ ...contact, doNotContact: true }).phone).toBeNull()
    expect(operatorContactView(contact, new Set(['sam@example.test'])).phone).toBeNull()
  })

  it('has a phone field in the contact output contract', () => {
    const detail = {
      contactId: 'c1',
      displayName: null,
      role: null,
      contactable: true,
      flags: { doNotContact: false, suppressed: false, unsubscribed: false, complained: false },
      email: null,
      phone: '+1 555 0100',
      venueId: null,
      archived: false,
      updatedAt: at(1).toISOString(),
      addressBlockedElsewhere: false,
      notes: null,
    }
    expect(
      OPERATOR_MCP_OUTPUTS['crm.list_contacts'].safeParse({
        items: [detail],
        nextCursor: null,
        complete: true,
      }).success,
    ).toBe(true)
  })
})
