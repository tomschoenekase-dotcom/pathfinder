import { describe, expect, it, vi } from 'vitest'
vi.mock('@pathfinder/db', () => ({ db: {}, writeAuditLogStrict: vi.fn() }))
import { saveMediaResolution } from './media-resolution-service'

const input = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  projectId: 'project-a',
  sourceGeneration: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  expectedUpdatedAt: '2026-09-07T09:00:00.000Z',
  expectedRevision: 1,
  decision: {
    kind: 'MERGE',
    candidateIds: ['a', 'b'],
    representativeId: 'a',
    rationale: 'Same sign and position.',
  },
}
describe('identity reviewer boundary', () => {
  it.each(['', '   ', '\t\n', 'x'.repeat(192)])(
    'rejects an invalid reviewer before a database operation',
    async (actorId) => {
      const client = { $transaction: vi.fn(), $queryRaw: vi.fn() }
      await expect(
        saveMediaResolution({ client: client as never, actorId, input }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      expect(client.$transaction).not.toHaveBeenCalled()
      expect(client.$queryRaw).not.toHaveBeenCalled()
    },
  )
})
