import { describe, expect, it, vi } from 'vitest'
import type { OperatorCallContext } from '../registry'
import { crmImportFieldTool } from './crm-import-field'
const input = { importId: 'import-1', rowId: 'row-1', field: 'notes' }
function context(found: boolean = true) {
  return {
    grant: { allTenants: true, userId: 'owner' },
    config: { allowedUserIds: new Set(['owner']) },
    database: {
      prospectImportRow: {
        findFirst: vi.fn().mockResolvedValue(
          found
            ? {
                sourceValues: { Research: 'x'.repeat(35_623) },
                normalizedValues: { notes: 'x'.repeat(35_623) },
              }
            : null,
        ),
      },
    },
  } as unknown as OperatorCallContext
}
describe('exact import field inspection', () => {
  it('pages a full long value with stable length/hash and import-scoped lookup', async () => {
    const ctx = context()
    const first = (await crmImportFieldTool.handler(input, ctx)) as {
      text: string
      length: number
      nextOffset: number
      sha256: string
    }
    expect(first).toMatchObject({
      length: 35_623,
      complete: false,
      nextOffset: 4000,
      untrusted: true,
    })
    expect(first.text).toHaveLength(4000)
    const last = await crmImportFieldTool.handler({ ...input, offset: 32_000 }, ctx)
    expect(last).toMatchObject({
      length: 35_623,
      complete: true,
      nextOffset: null,
      sha256: first.sha256,
      text: 'x'.repeat(3623),
    })
    expect(ctx.database.prospectImportRow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-1', importId: 'import-1' } }),
    )
  })
  it('refuses narrowed grants, wrong import rows and unknown fields', async () => {
    const limited = context()
    Object.assign(limited.grant, { allTenants: false })
    await expect(crmImportFieldTool.handler(input, limited)).rejects.toMatchObject({
      code: 'FORBIDDEN_ACTOR',
    })
    expect(limited.database.prospectImportRow.findFirst).not.toHaveBeenCalled()
    await expect(crmImportFieldTool.handler(input, context(false))).rejects.toThrow()
    await expect(
      crmImportFieldTool.handler({ ...input, field: '__proto__' }, context()),
    ).rejects.toThrow()
  })
})
