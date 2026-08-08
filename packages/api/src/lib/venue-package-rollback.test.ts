import { describe, expect, it } from 'vitest'

import {
  planVenuePackageRollback,
  venuePackageSnapshotsEqual,
  type AppliedVenuePackageEffect,
  type JsonSnapshot,
  type LaterContentVersion,
} from './venue-package-rollback'

const original: JsonSnapshot = {
  id: 'place-1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  createdAt: '2026-08-08T00:00:00.000Z',
  name: 'Old name',
  description: 'Old description',
  metadata: { accessible: false, labels: ['quiet'] },
}

const packageState: JsonSnapshot = {
  ...original,
  name: 'Package name',
  metadata: { accessible: true, labels: ['quiet'] },
}

function effect(
  operation: AppliedVenuePackageEffect['operation'] = 'UPDATE',
): AppliedVenuePackageEffect {
  return {
    entityType: 'PLACE',
    entityId: 'place-1',
    operation,
    applyVersionId: 'version-a',
    beforeState: operation === 'CREATE' ? null : original,
    afterState: operation === 'DELETE' ? null : packageState,
  }
}

function later(
  values: Partial<LaterContentVersion> & Pick<LaterContentVersion, 'id' | 'operation'>,
): LaterContentVersion {
  return {
    entityType: 'PLACE',
    entityId: 'place-1',
    beforeState: packageState,
    afterState: packageState,
    revertedFromId: null,
    ...values,
  }
}

describe('venuePackageSnapshotsEqual', () => {
  it('uses deep JSON equality without depending on object key order', () => {
    expect(
      venuePackageSnapshotsEqual(
        { a: 1, nested: { b: [true, null, 'x'] } },
        { nested: { b: [true, null, 'x'] }, a: 1 },
      ),
    ).toBe(true)
    expect(venuePackageSnapshotsEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
  })
})

describe('planVenuePackageRollback', () => {
  it('returns a patch limited to fields touched by the package update', () => {
    const result = planVenuePackageRollback({
      effect: effect(),
      laterVersions: [],
      currentState: packageState,
    })

    expect(result).toEqual({
      ok: true,
      plan: {
        operation: 'PATCH',
        fields: {
          metadata: original.metadata,
          name: 'Old name',
        },
        unsetFields: [],
        expectedFields: {
          metadata: packageState.metadata,
          name: 'Package name',
        },
        expectedUnsetFields: [],
      },
    })
  })

  it('preserves an uncompensated later update to a disjoint field', () => {
    const afterLater = { ...packageState, description: 'Human follow-up' }
    const result = planVenuePackageRollback({
      effect: effect(),
      laterVersions: [
        later({
          id: 'version-b',
          operation: 'UPDATE',
          beforeState: packageState,
          afterState: afterLater,
        }),
      ],
      currentState: afterLater,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.operation).toBe('PATCH')
      if (result.plan.operation === 'PATCH') {
        expect(result.plan.fields).toEqual({ metadata: original.metadata, name: 'Old name' })
        expect(result.plan.fields).not.toHaveProperty('description')
      }
    }
  })

  it('rejects an uncompensated later update that overlaps a package field', () => {
    const afterLater = { ...packageState, name: 'Later name' }
    expect(
      planVenuePackageRollback({
        effect: effect(),
        laterVersions: [
          later({
            id: 'version-b',
            operation: 'UPDATE',
            beforeState: packageState,
            afterState: afterLater,
          }),
        ],
        currentState: afterLater,
      }),
    ).toMatchObject({ ok: false, code: 'OVERLAPPING_UPDATE' })
  })

  it('folds an exact B apply plus B revert before rolling back A', () => {
    const afterB = { ...packageState, description: 'Temporary B' }
    const result = planVenuePackageRollback({
      effect: effect(),
      laterVersions: [
        later({
          id: 'version-b',
          operation: 'UPDATE',
          beforeState: packageState,
          afterState: afterB,
        }),
        later({
          id: 'version-b-revert',
          operation: 'UPDATE',
          beforeState: afterB,
          afterState: packageState,
          revertedFromId: 'version-b',
        }),
      ],
      currentState: packageState,
    })

    expect(result).toMatchObject({ ok: true, plan: { operation: 'PATCH' } })
  })

  it('treats a valid non-adjacent field-local revert as a later change', () => {
    const beforeC = { ...original, category: 'old' }
    const afterC = { ...original, category: 'package-c' }
    const afterA = { ...packageState, category: 'package-c' }
    const afterB = { ...afterA, description: 'Persistent B' }
    const afterARevert = { ...afterC, description: 'Persistent B' }
    const result = planVenuePackageRollback({
      effect: {
        ...effect(),
        applyVersionId: 'version-before-a',
        beforeState: beforeC,
        afterState: afterC,
      },
      laterVersions: [
        later({
          id: 'version-a',
          operation: 'UPDATE',
          beforeState: afterC,
          afterState: afterA,
        }),
        later({
          id: 'version-b',
          operation: 'UPDATE',
          beforeState: afterA,
          afterState: afterB,
        }),
        later({
          id: 'version-a-revert',
          operation: 'UPDATE',
          beforeState: afterB,
          afterState: afterARevert,
          revertedFromId: 'version-a',
        }),
      ],
      currentState: afterARevert,
    })

    expect(result).toMatchObject({ ok: true, plan: { operation: 'PATCH' } })
  })

  it('accepts a non-adjacent revert of a verified ancestor predating the package effect', () => {
    const afterB = { ...packageState, description: 'Package B' }
    const afterAncestorRevert = { ...original, description: 'Package B' }
    const result = planVenuePackageRollback({
      effect: {
        ...effect(),
        applyVersionId: 'version-b',
        beforeState: packageState,
        afterState: afterB,
      },
      laterVersions: [
        later({
          id: 'version-ancestor-revert',
          operation: 'UPDATE',
          beforeState: afterB,
          afterState: afterAncestorRevert,
          revertedFromId: 'version-before-package',
        }),
      ],
      knownAncestorVersionIds: ['version-before-package'],
      currentState: afterAncestorRevert,
    })

    expect(result).toMatchObject({ ok: true, plan: { operation: 'PATCH' } })
  })

  it('rejects a revert whose ancestry does not point to its immediate predecessor', () => {
    const afterB = { ...packageState, description: 'Temporary B' }
    expect(
      planVenuePackageRollback({
        effect: effect(),
        laterVersions: [
          later({
            id: 'version-b',
            operation: 'UPDATE',
            beforeState: packageState,
            afterState: afterB,
          }),
          later({
            id: 'bad-revert',
            operation: 'UPDATE',
            beforeState: afterB,
            afterState: packageState,
            revertedFromId: 'another-version',
          }),
        ],
        currentState: packageState,
      }),
    ).toMatchObject({ ok: false, code: 'LINEAGE_MISMATCH' })
  })

  it('rejects a revert that is not the exact inverse of its predecessor', () => {
    const afterB = { ...packageState, description: 'Temporary B' }
    expect(
      planVenuePackageRollback({
        effect: effect(),
        laterVersions: [
          later({
            id: 'version-b',
            operation: 'UPDATE',
            beforeState: packageState,
            afterState: afterB,
          }),
          later({
            id: 'bad-revert',
            operation: 'UPDATE',
            beforeState: afterB,
            afterState: { ...packageState, description: 'Not the original state' },
            revertedFromId: 'version-b',
          }),
        ],
        currentState: packageState,
      }),
    ).toMatchObject({ ok: false, code: 'LINEAGE_MISMATCH' })
  })

  it('rejects discontinuous history and a current snapshot outside the supplied lineage', () => {
    const afterLater = { ...packageState, description: 'Human follow-up' }
    expect(
      planVenuePackageRollback({
        effect: effect(),
        laterVersions: [
          later({
            id: 'version-b',
            operation: 'UPDATE',
            beforeState: original,
            afterState: afterLater,
          }),
        ],
        currentState: afterLater,
      }),
    ).toMatchObject({ ok: false, code: 'LINEAGE_MISMATCH' })

    expect(
      planVenuePackageRollback({ effect: effect(), laterVersions: [], currentState: original }),
    ).toMatchObject({ ok: false, code: 'CURRENT_STATE_MISMATCH' })
  })

  it('returns DELETE for a package create only when no later work remains', () => {
    const createEffect = effect('CREATE')
    expect(
      planVenuePackageRollback({
        effect: createEffect,
        laterVersions: [],
        currentState: packageState,
      }),
    ).toEqual({ ok: true, plan: { operation: 'DELETE', expectedState: packageState } })

    const afterLater = { ...packageState, description: 'Later edit' }
    expect(
      planVenuePackageRollback({
        effect: createEffect,
        laterVersions: [
          later({
            id: 'version-b',
            operation: 'UPDATE',
            beforeState: packageState,
            afterState: afterLater,
          }),
        ],
        currentState: afterLater,
      }),
    ).toMatchObject({ ok: false, code: 'LATER_CHANGE_CONFLICT' })
  })

  it('returns CREATE for a package delete and rejects a later recreation', () => {
    const deleteEffect = effect('DELETE')
    expect(
      planVenuePackageRollback({ effect: deleteEffect, laterVersions: [], currentState: null }),
    ).toEqual({ ok: true, plan: { operation: 'CREATE', state: original } })

    expect(
      planVenuePackageRollback({
        effect: deleteEffect,
        laterVersions: [
          later({
            id: 'version-b',
            operation: 'CREATE',
            beforeState: null,
            afterState: original,
          }),
        ],
        currentState: original,
      }),
    ).toMatchObject({ ok: false, code: 'LATER_CHANGE_CONFLICT' })
  })

  it('rejects a delete and recreate in later history for an update', () => {
    expect(
      planVenuePackageRollback({
        effect: effect(),
        laterVersions: [
          later({
            id: 'delete-b',
            operation: 'DELETE',
            beforeState: packageState,
            afterState: null,
          }),
          later({
            id: 'create-c',
            operation: 'CREATE',
            beforeState: null,
            afterState: packageState,
          }),
        ],
        currentState: packageState,
      }),
    ).toMatchObject({ ok: false, code: 'LATER_CHANGE_CONFLICT' })
  })

  it('rejects malformed update states and immutable identity changes', () => {
    expect(
      planVenuePackageRollback({
        effect: { ...effect(), beforeState: null },
        laterVersions: [],
        currentState: packageState,
      }),
    ).toMatchObject({ ok: false, code: 'MALFORMED_APPLIED_EFFECT' })

    expect(
      planVenuePackageRollback({
        effect: {
          ...effect(),
          afterState: { ...packageState, tenantId: 'another-tenant' },
        },
        laterVersions: [],
        currentState: { ...packageState, tenantId: 'another-tenant' },
      }),
    ).toMatchObject({ ok: false, code: 'MALFORMED_APPLIED_EFFECT' })
  })

  it('represents absent fields explicitly in a patch plan', () => {
    const before = { ...original }
    delete before.description
    const after = { ...packageState, extra: 'package-only' }
    const result = planVenuePackageRollback({
      effect: { ...effect(), beforeState: before, afterState: after },
      laterVersions: [],
      currentState: after,
    })

    expect(result).toMatchObject({
      ok: true,
      plan: {
        operation: 'PATCH',
        fields: { metadata: original.metadata, name: 'Old name' },
        unsetFields: ['description', 'extra'],
        expectedFields: {
          description: 'Old description',
          extra: 'package-only',
          metadata: packageState.metadata,
          name: 'Package name',
        },
      },
    })
  })
})
