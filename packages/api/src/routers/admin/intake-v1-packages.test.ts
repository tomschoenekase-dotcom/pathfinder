import { beforeEach, describe, expect, it, vi } from 'vitest'

const { candidate, CandidateError } = vi.hoisted(() => {
  class CandidateError extends Error {
    constructor(readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT') {
      super(code)
    }
  }
  return { candidate: vi.fn(), CandidateError }
})

vi.mock('../../lib/intake-v1-package-candidate', () => ({
  buildIntakeV1PackageCandidate: candidate,
  IntakeV1PackageCandidateError: CandidateError,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminIntakeV1PackagesRouter } from './intake-v1-packages'

const app = router({ admin: adminIntakeV1PackagesRouter })
const input = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  submissionId: 'submission-a',
  revision: 1,
  selectedMemberIds: ['member-a'],
}

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'user-a',
      activeTenantId: 'tenant-session',
      role: 'OWNER',
      isPlatformAdmin,
    },
  }
}

describe('admin V1 package routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    candidate.mockResolvedValue({ ready: false, members: [] })
  })

  it('denies an ordinary tenant session before it can read candidate data', async () => {
    await expect(
      app.createCaller(context(false)).admin.previewIntakeV1Package(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(candidate).not.toHaveBeenCalled()
  })

  it('passes the exact explicit tenant, venue, revision, and selection scope to the candidate', async () => {
    await expect(
      app.createCaller(context(true)).admin.previewIntakeV1Package(input),
    ).resolves.toEqual({ ready: false, members: [] })
    expect(candidate).toHaveBeenCalledWith({ db: expect.anything(), ...input })
  })

  it('maps duplicate candidate input and rejects oversized selections before a candidate read', async () => {
    candidate.mockRejectedValueOnce(new CandidateError('INVALID_INPUT'))
    await expect(
      app
        .createCaller(context(true))
        .admin.previewIntakeV1Package({ ...input, selectedMemberIds: ['member-a', 'member-a'] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(candidate).toHaveBeenCalledTimes(1)
    vi.resetAllMocks()
    await expect(
      app.createCaller(context(true)).admin.previewIntakeV1Package({
        ...input,
        selectedMemberIds: Array.from({ length: 51 }, (_, index) => `member-${index}`),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(candidate).not.toHaveBeenCalled()
  })
})
