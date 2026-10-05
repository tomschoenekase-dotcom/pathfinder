import { describe, expect, it, vi } from 'vitest'
import { readPackageApplyHistory, type PackagePendingEffect } from './venue-package-apply-history'

const effects: PackagePendingEffect[] = [
  { itemKey: 'item-a', entityType: 'KNOWLEDGE_ENTRY', entityId: 'entry-a', operation: 'CREATE' },
  { itemKey: 'item-b', entityType: 'PLACE', entityId: 'place-b', operation: 'UPDATE' },
]
const versions = effects.map((effect, index) => ({
  ...effect,
  id: `version-${index}`,
  venuePackageItemKey: effect.itemKey,
  snapshotSchemaVersion: 1,
  beforeState: index ? { name: 'before' } : null,
  afterState: { content: 'exact original content' },
}))
function run(rows = versions) {
  const findMany = vi.fn(async () => rows)
  return {
    findMany,
    result: readPackageApplyHistory({
      db: { contentVersion: { findMany } } as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      packageId: 'package-1',
      effects,
    }),
  }
}
describe('package apply history verification', () => {
  it('binds exact scope and retains effect order and snapshots from unordered history', async () => {
    const { result, findMany } = run([...versions].reverse())
    expect(await result).toEqual(
      effects.map((effect, index) => ({
        ...effect,
        applyVersionId: versions[index]!.id,
        snapshotSchemaVersion: 1,
        beforeState: versions[index]!.beforeState,
        afterState: versions[index]!.afterState,
      })),
    )
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          venuePackageId: 'package-1',
          venuePackageAction: 'APPLY',
        },
        take: 3,
      }),
    )
  })
  it.each([
    ['missing receipt', versions.slice(0, 1)],
    ['extra receipt', [...versions, { ...versions[0]!, venuePackageItemKey: 'extra' }]],
    ['duplicate receipt', [versions[0]!, versions[0]!]],
    ['wrong item', [{ ...versions[0]!, venuePackageItemKey: 'other' }, versions[1]!]],
    ['wrong entity', [{ ...versions[0]!, entityId: 'other' }, versions[1]!]],
    ['wrong operation', [{ ...versions[0]!, operation: 'DELETE' }, versions[1]!]],
    ['wrong entity type', [{ ...versions[0]!, entityType: 'PLACE' }, versions[1]!]],
  ])('refuses %s before the transaction can commit', async (_name, rows) => {
    await expect(run(rows as typeof versions).result).rejects.toThrow('expected immutable history')
  })
})
