import { describe, expect, it } from 'vitest'

import { parseEmbeddingClaimRepairArgs } from './embedding-claim-repair-cli'

const validArgs = [
  '--repair-reason',
  'complete-claim-missing-vector-invariant-breach',
  '--tenant-id',
  'tenant-1',
  '--venue-id',
  'venue-1',
  '--entity-type',
  'PLACE',
  '--entity-id',
  'place-1',
  '--confirm-entity-id',
  'place-1',
  '--confirm-dispatcher-disabled',
  'true',
  '--actor-id',
  'operator-1',
]
const staging = { RAILWAY_ENVIRONMENT: 'staging', EMBEDDING_DISPATCH_ENABLED: 'false' }

describe('embedding claim repair CLI', () => {
  it('accepts one exact, explicitly confirmed staging entity', () => {
    expect(parseEmbeddingClaimRepairArgs(validArgs, staging)).toMatchObject({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      entityType: 'PLACE',
      entityId: 'place-1',
      dispatcherDisabledAsserted: true,
    })
  })

  it.each([
    [{ ...staging, RAILWAY_ENVIRONMENT: 'production' }, 'RAILWAY_ENVIRONMENT=staging'],
    [{ ...staging, EMBEDDING_DISPATCH_ENABLED: 'true' }, 'EMBEDDING_DISPATCH_ENABLED=false'],
  ])('rejects unsafe environment %#', (environment, message) => {
    expect(() => parseEmbeddingClaimRepairArgs(validArgs, environment)).toThrow(message)
  })

  it('rejects a mismatched entity confirmation', () => {
    const args = [...validArgs]
    args[args.indexOf('--confirm-entity-id') + 1] = 'different-place'
    expect(() => parseEmbeddingClaimRepairArgs(args, staging)).toThrow('must exactly match')
  })

  it('rejects a generic freshness reason', () => {
    const args = [...validArgs]
    args[args.indexOf('--repair-reason') + 1] = 'missing-vector-no-claim'
    expect(() => parseEmbeddingClaimRepairArgs(args, staging)).toThrow('exact supported')
  })

  it('rejects unknown flags that could imply false safety', () => {
    expect(() =>
      parseEmbeddingClaimRepairArgs([...validArgs, '--dry-run', 'true'], staging),
    ).toThrow('Unknown argument --dry-run')
  })
})
