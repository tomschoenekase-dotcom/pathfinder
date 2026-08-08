import { describe, expect, it } from 'vitest'

import { changedSnapshotFields, currentDeletedVersions } from './content-history-diff'

describe('changedSnapshotFields', () => {
  it('returns only changed content fields in stable order', () => {
    expect(
      changedSnapshotFields(
        { id: 'place_1', tenantId: 'tenant_1', name: 'Old', tags: ['a'], isActive: true },
        { id: 'place_1', tenantId: 'tenant_1', name: 'New', tags: ['a'], isActive: false },
      ),
    ).toEqual([
      { key: 'isActive', before: true, after: false },
      { key: 'name', before: 'Old', after: 'New' },
    ])
  })

  it('shows every content field for create and delete snapshots', () => {
    expect(changedSnapshotFields(null, { id: 'entry_1', title: 'Answer' })).toEqual([
      { key: 'title', before: undefined, after: 'Answer' },
    ])
    expect(changedSnapshotFields({ id: 'entry_1', title: 'Answer' }, null)).toEqual([
      { key: 'title', before: 'Answer', after: undefined },
    ])
  })

  it('does not treat identity scope as an editable diff', () => {
    expect(
      changedSnapshotFields(
        { id: 'old', tenantId: 'old', venueId: 'old' },
        { id: 'new', tenantId: 'new', venueId: 'new' },
      ),
    ).toEqual([])
  })
})

describe('currentDeletedVersions', () => {
  it('returns only entities whose newest loaded revision is a deletion', () => {
    const versions = [
      { id: 'a-delete', entityType: 'PLACE', entityId: 'a', afterState: null },
      { id: 'b-update', entityType: 'PLACE', entityId: 'b', afterState: { name: 'Current' } },
      { id: 'a-create', entityType: 'PLACE', entityId: 'a', afterState: { name: 'Old' } },
      { id: 'b-delete', entityType: 'PLACE', entityId: 'b', afterState: null },
    ]
    expect(currentDeletedVersions(versions).map((version) => version.id)).toEqual(['a-delete'])
  })
})
