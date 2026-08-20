import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  createProspect: vi.fn(),
  beginImport: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  ProspectActionError: class ProspectActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  withTenantIsolationBypass: mocks.bypass,
  createProspectAction: mocks.createProspect,
  beginProspectImportAction: mocks.beginImport,
  addProspectNoteAction: vi.fn(),
  approveProspectImportAction: vi.fn(),
  archiveProspectAction: vi.fn(),
  commitProspectImportBatchAction: vi.fn(),
  linkProspectConversionAction: vi.fn(),
  resolveProspectDuplicateAction: vi.fn(),
  resolveProspectImportRowAction: vi.fn(),
  scanProspectDuplicatesAction: vi.fn(),
  stageProspectImportRowsAction: vi.fn(),
  updateProspectPipelineAction: vi.fn(),
  db: {},
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminProspectCrmRouter } from './prospect-crm'

const testRouter = router({ crm: adminProspectCrmRouter })

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('admin prospect CRM router', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects non-admin reads and writes before bypass or action dispatch', async () => {
    const caller = testRouter.createCaller(context(false)).crm
    await expect(caller.listProspects({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<TRPCError>)
    await expect(
      caller.createProspect({ organization: { canonicalName: 'Blocked prospect' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.createProspect).not.toHaveBeenCalled()
  })

  it('derives the human platform-admin actor from the authenticated session', async () => {
    mocks.createProspect.mockResolvedValue({
      organization: { id: 'prospect_1' },
      venue: null,
      contact: null,
    })
    const result = await testRouter
      .createCaller(context(true))
      .crm.createProspect({ organization: { canonicalName: 'Authorized prospect' } })
    expect(result.organization.id).toBe('prospect_1')
    expect(mocks.createProspect).toHaveBeenCalledWith({
      organization: { canonicalName: 'Authorized prospect' },
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('rejects oversized imports at the API boundary before action dispatch', async () => {
    await expect(
      testRouter.createCaller(context(true)).crm.beginProspectImport({
        fileName: 'oversized.xlsx',
        fileType: 'xlsx',
        fileSize: 25 * 1024 * 1024 + 1,
        fileHash: 'a'.repeat(64),
        mappingHash: 'b'.repeat(64),
        mapping: {},
        sheets: [{ sheetName: 'Data', sheetIndex: 0, detectedRows: 1, columns: [] }],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>)
    expect(mocks.beginImport).not.toHaveBeenCalled()
  })
})
