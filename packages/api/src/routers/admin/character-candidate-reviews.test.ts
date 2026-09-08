import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  brief: vi.fn(),
  character: vi.fn(),
  submit: vi.fn(),
  decide: vi.fn(),
  preview: vi.fn(),
  fingerprint: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({
  db: { characterCandidateReviewBrief: { findMany: mocks.list, findFirst: mocks.brief } },
  withTenantIsolationBypass: (fn: () => unknown) => fn(),
  submitCharacterCandidateReviewBrief: mocks.submit,
  decideCharacterCandidateReview: mocks.decide,
  readCustomCharacterFactoryAction: mocks.character,
  characterCandidateArtifactFingerprint: mocks.fingerprint,
}))
vi.mock('../../lib/character-artifact-storage', () => ({
  createCharacterArtifactStorage: () => ({}),
}))
vi.mock('../../lib/character-candidate-preview', () => ({
  readCharacterCandidateMasterPreview: mocks.preview,
}))
import type { TRPCContext } from '../../context'
import { adminCharacterCandidateReviewsRouter } from './character-candidate-reviews'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a' }
const snapshot = {
  ...scope,
  briefId: 'brief-a',
  expectedVersion: 1,
  expectedRevision: 2,
  expectedArtifactFingerprint: 'a'.repeat(64),
}
const decision = {
  ...snapshot,
  operationId: '10000000-0000-4000-8000-000000000001',
  decision: 'ACCEPT' as const,
}
const row = {
  id: 'brief-a',
  ...scope,
  customCharacterId: 'character-a',
  candidateVersion: 1,
  candidateRevision: 2,
  artifactFingerprint: 'a'.repeat(64),
  brief: 'Neutral fixture brief',
  rationale: 'Producer rationale',
  sourceProvenance: 'IMPORTED_FIXTURE',
  createdAt: new Date('2026-09-08T00:00:00Z'),
  tenant: { name: 'Fixture operator' },
  venue: { name: 'Fixture venue' },
  customCharacter: {
    displayName: 'Neutral fixture',
    status: 'REVIEW',
    version: 1,
    revision: 2,
    assetStorageReference: { privateKey: 'must-not-project' },
  },
}
function caller(admin = true) {
  return adminCharacterCandidateReviewsRouter.createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'founder',
      activeTenantId: 'tenant-a',
      role: 'OWNER',
      isPlatformAdmin: admin,
    },
  })
}

describe('founder candidate review API boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.fingerprint.mockReturnValue('a'.repeat(64))
    mocks.list.mockResolvedValue([row])
    mocks.brief.mockResolvedValue(row)
    mocks.character.mockResolvedValue({
      ...row.customCharacter,
      spec: { characterId: 'character-a' },
    })
  })
  it('denies ordinary tenant owners from review, listing and private preview', async () => {
    await expect(caller(false).listCharacterCandidateReviews({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(caller(false).decideCharacterCandidateReview(decision)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(caller(false).readCharacterCandidatePreview(snapshot)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(mocks.preview).not.toHaveBeenCalled()
  })
  it('projects only bounded review facts and a same-origin exact-snapshot preview path', async () => {
    const result = await caller().listCharacterCandidateReviews({})
    expect(result.items[0]).toMatchObject({
      characterId: 'character-a',
      current: true,
      provenance: 'Imported fixture · reported by producer',
    })
    expect(result.items[0]?.previewHref).toContain(
      '/api/admin/character-candidate-preview?tenantId=tenant-a&venueId=venue-a&briefId=brief-a',
    )
    expect(JSON.stringify(result)).not.toContain('must-not-project')
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ take: 13, where: { decision: { is: null } } }),
    )
  })
  it('uses a stable bounded cursor so stale older reviews cannot hide later candidates', async () => {
    mocks.list.mockResolvedValue([row, { ...row, id: 'brief-b' }])
    const result = await caller().listCharacterCandidateReviews({
      limit: 1,
      cursor: { createdAt: row.createdAt, id: 'prior' },
    })
    expect(result.nextCursor).toEqual({ createdAt: row.createdAt, id: row.id })
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          decision: { is: null },
          OR: [
            { createdAt: { gt: row.createdAt } },
            { createdAt: row.createdAt, id: { gt: 'prior' } },
          ],
        },
      }),
    )
  })
  it('derives human actor and returns only the immutable decision job receipt', async () => {
    mocks.decide.mockResolvedValue({
      decision: { decision: 'ACCEPT', resultingJobId: 'job-a' },
      replayed: false,
    })
    expect(await caller().decideCharacterCandidateReview(decision)).toEqual({
      decision: 'ACCEPT',
      jobId: 'job-a',
      replayed: false,
    })
    expect(mocks.decide).toHaveBeenCalledWith({
      ...decision,
      actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'founder' },
    })
    await expect(
      caller().decideCharacterCandidateReview({ ...decision, actor: { id: 'injected' } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.decide).toHaveBeenCalledTimes(1)
  })
  it.each(['fingerprint', 'revision', 'archived'])(
    'denies %s drift before accessing stored art',
    async (kind) => {
      if (kind === 'fingerprint') mocks.fingerprint.mockReturnValue('b'.repeat(64))
      if (kind === 'revision')
        mocks.character.mockResolvedValue({ ...row.customCharacter, revision: 3 })
      if (kind === 'archived')
        mocks.character.mockResolvedValue({ ...row.customCharacter, status: 'ARCHIVED' })
      await expect(caller().readCharacterCandidatePreview(snapshot)).rejects.toMatchObject({
        code: 'CONFLICT',
      })
      expect(mocks.preview).not.toHaveBeenCalled()
    },
  )
  it('does not read artifact data for a missing or foreign scoped brief', async () => {
    mocks.brief.mockResolvedValue(null)
    await expect(caller().readCharacterCandidatePreview(snapshot)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(mocks.brief).toHaveBeenCalledWith({ where: { id: 'brief-a', ...scope } })
    expect(mocks.character).not.toHaveBeenCalled()
    expect(mocks.preview).not.toHaveBeenCalled()
  })
})
