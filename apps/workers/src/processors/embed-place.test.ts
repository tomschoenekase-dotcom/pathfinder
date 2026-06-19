import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  placeFindFirst: vi.fn(),
  generateAndStorePlaceEmbedding: vi.fn(),
  updateJobRecord: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    place: {
      findFirst: mocks.placeFindFirst,
    },
  },
  generateAndStorePlaceEmbedding: mocks.generateAndStorePlaceEmbedding,
  updateJobRecord: mocks.updateJobRecord,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
}))

import { processEmbedPlaceJob } from './embed-place'

const place = {
  id: 'place_1',
  name: 'Main Hall',
  type: 'exhibit',
  itemType: null,
  shortDescription: 'A short description',
  longDescription: null,
  tags: ['art'],
  areaName: 'First Floor',
  hours: null,
}

describe('processEmbedPlaceJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.generateAndStorePlaceEmbedding.mockResolvedValue(undefined)
  })

  it('loads the place by tenant and stores an embedding', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)

    await processEmbedPlaceJob({ tenantId: 'tenant_1', placeId: 'place_1' }, 'bull_1')

    expect(mocks.writeJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: 'embed-place',
        jobName: 'embed-place-process',
        bullJobId: 'bull_1',
        tenantId: 'tenant_1',
        status: 'RUNNING',
      }),
    )
    expect(mocks.placeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'place_1',
          tenantId: 'tenant_1',
          isActive: true,
        },
      }),
    )
    expect(mocks.generateAndStorePlaceEmbedding).toHaveBeenCalledWith(place)
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })
})
