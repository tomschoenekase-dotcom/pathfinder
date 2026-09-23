import { describe, expect, it, vi } from 'vitest'
import { encodeSalesComponent, salesHash } from './prospect-sales-snapshot'
import {
  importNativeWriterResult,
  readNativeWriterImportReceipt,
  WRITER_IMPORT_SCHEMA,
  type NativeWriterResult,
} from './prospect-sales-writer'

const binding = {
  venueId: 'SYN-venue', organizationId: 'SYN-org', preparationId: 'SYN-prep',
  nativeSnapshotHash: 'a'.repeat(64), preparationHash: 'b'.repeat(64),
  componentCodeHash: 'c'.repeat(64), fileSetHash: 'd'.repeat(64),
  selectionId: null, routeHash: 'e'.repeat(64), routeKind: 'email',
  recipient: 'fixture@example.invalid', formUrl: null, threadHash: 'f'.repeat(64),
  libraryHash: '1'.repeat(64), wltHash: '2'.repeat(64), expectedDraftId: null,
  expectedVenueDraftId: null, expectedMeaningReviewId: null, expectedReadReviewId: null,
}
const result: NativeWriterResult = {
  schema: 'torchiko.native-writer-result/1',
  taskId: 'writer-task_' + salesHash(binding), binding,
  generatedBy: { kind: 'model', identity: 'Model candidate' },
  subject: 'Synthetic receipt check', body: 'No send requested.',
  annotations: [], languageUses: [], assessment: null,
}
const resultHash = salesHash(result)
const receipt = {
  id: 'writer-import_' + salesHash({ taskId: result.taskId, resultHash }).slice(0, 40),
  venueId: binding.venueId,
  evidence: {
    schema: WRITER_IMPORT_SCHEMA, taskId: result.taskId, resultHash,
    draftId: 'SYN-old-draft', meaningReviewId: null,
    SEND_AUTHORIZED: false,
    record: encodeSalesComponent({ binding, result, SEND_AUTHORIZED: false }),
  },
}

describe('immutable writer import reconciliation', () => {
  it('returns the exact committed receipt before reading a later mutable head', async () => {
    const findUnique = vi.fn().mockResolvedValue(receipt)
    const tx = { prospectActivity: { findUnique } }
    const client = { $transaction: vi.fn(async (fn) => fn(tx)) }
    const observed = await importNativeWriterResult({
      result, component: {},
      actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'unit-only-actor' },
      assess: vi.fn(),
    }, client as never)
    expect(observed).toBe(receipt)
    expect(client.$transaction).toHaveBeenCalledOnce()
    expect(findUnique).toHaveBeenCalledWith({ where: { id: receipt.id } })
  })

  it('rejects a mismatched stored receipt instead of claiming a replay', async () => {
    const client = { prospectActivity: { findUnique: vi.fn().mockResolvedValue({
      ...receipt, evidence: { ...receipt.evidence, resultHash: '0'.repeat(64) },
    }) } }
    await expect(readNativeWriterImportReceipt(result, client as never))
      .rejects.toThrow('WRITER_RECEIPT_CONFLICT')
  })
})
