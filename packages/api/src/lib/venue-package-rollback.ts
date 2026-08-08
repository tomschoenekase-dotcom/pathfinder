export type VenuePackageRollbackEntityType = 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY'

export type VenuePackageRollbackOperation = 'CREATE' | 'UPDATE' | 'DELETE'

export type JsonSnapshot = Record<string, unknown>

export interface AppliedVenuePackageEffect {
  entityType: VenuePackageRollbackEntityType
  entityId: string
  operation: VenuePackageRollbackOperation
  applyVersionId: string
  beforeState: JsonSnapshot | null
  afterState: JsonSnapshot | null
}

export interface LaterContentVersion {
  id: string
  entityType: VenuePackageRollbackEntityType
  entityId: string
  operation: VenuePackageRollbackOperation
  beforeState: JsonSnapshot | null
  afterState: JsonSnapshot | null
  revertedFromId?: string | null
}

export type VenuePackageInversePlan =
  | { operation: 'DELETE'; expectedState: JsonSnapshot }
  | { operation: 'CREATE'; state: JsonSnapshot }
  | {
      operation: 'PATCH'
      fields: JsonSnapshot
      unsetFields: string[]
      expectedFields: JsonSnapshot
      expectedUnsetFields: string[]
    }

export type VenuePackageRollbackFailureCode =
  | 'MALFORMED_APPLIED_EFFECT'
  | 'MALFORMED_LATER_VERSION'
  | 'LINEAGE_MISMATCH'
  | 'CURRENT_STATE_MISMATCH'
  | 'LATER_CHANGE_CONFLICT'
  | 'OVERLAPPING_UPDATE'

export type VenuePackageRollbackResult =
  | { ok: true; plan: VenuePackageInversePlan }
  | { ok: false; code: VenuePackageRollbackFailureCode; message: string }

export interface PlanVenuePackageRollbackInput {
  effect: AppliedVenuePackageEffect
  /** Records must be supplied oldest first. */
  laterVersions: LaterContentVersion[]
  /** Earlier versions verified by the caller as belonging to this same entity. */
  knownAncestorVersionIds?: string[]
  currentState: JsonSnapshot | null
}

const IMMUTABLE_PATCH_FIELDS = new Set(['id', 'tenantId', 'venueId', 'createdAt'])

function failure(
  code: VenuePackageRollbackFailureCode,
  message: string,
): VenuePackageRollbackResult {
  return { ok: false, code, message }
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false

  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

function isSnapshot(value: unknown): value is JsonSnapshot {
  return value !== null && !Array.isArray(value) && isJsonValue(value)
}

export function venuePackageSnapshotsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => venuePackageSnapshotsEqual(value, right[index]))
  }

  if (typeof left !== 'object') return false

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  if (!venuePackageSnapshotsEqual(leftKeys, rightKeys)) return false

  return leftKeys.every((key) => venuePackageSnapshotsEqual(leftRecord[key], rightRecord[key]))
}

function changedFields(before: JsonSnapshot, after: JsonSnapshot): Set<string> {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)])
  return new Set(
    [...fields].filter((field) => !venuePackageSnapshotsEqual(before[field], after[field])),
  )
}

function immutableFieldsMatch(before: JsonSnapshot, after: JsonSnapshot): boolean {
  return [...IMMUTABLE_PATCH_FIELDS].every((field) => {
    const beforeHasField = Object.prototype.hasOwnProperty.call(before, field)
    const afterHasField = Object.prototype.hasOwnProperty.call(after, field)
    return (
      beforeHasField === afterHasField &&
      (!beforeHasField || venuePackageSnapshotsEqual(before[field], after[field]))
    )
  })
}

function transitionIsWellFormed(
  action: VenuePackageRollbackOperation,
  beforeState: JsonSnapshot | null,
  afterState: JsonSnapshot | null,
): boolean {
  if (action === 'CREATE') return beforeState === null && isSnapshot(afterState)
  if (action === 'DELETE') return isSnapshot(beforeState) && afterState === null
  return (
    isSnapshot(beforeState) &&
    isSnapshot(afterState) &&
    immutableFieldsMatch(beforeState, afterState) &&
    changedFields(beforeState, afterState).size > 0
  )
}

function operationMatchesStates(
  operation: VenuePackageRollbackOperation,
  beforeState: JsonSnapshot | null,
  afterState: JsonSnapshot | null,
): boolean {
  return transitionIsWellFormed(operation, beforeState, afterState)
}

/**
 * Produces a conservative inverse for one V3 package effect.
 *
 * The caller must provide complete snapshots and all later versions for the same
 * entity in chronological order. The planner treats missing or malformed history
 * as a conflict instead of guessing.
 */
export function planVenuePackageRollback({
  effect,
  laterVersions,
  knownAncestorVersionIds = [],
  currentState,
}: PlanVenuePackageRollbackInput): VenuePackageRollbackResult {
  if (
    !effect.entityId ||
    !effect.applyVersionId ||
    !operationMatchesStates(effect.operation, effect.beforeState, effect.afterState)
  ) {
    return failure('MALFORMED_APPLIED_EFFECT', 'The applied package effect has invalid snapshots.')
  }

  if (currentState !== null && !isSnapshot(currentState)) {
    return failure('CURRENT_STATE_MISMATCH', 'The current entity snapshot is malformed.')
  }

  const seenVersionIds = new Set<string>([effect.applyVersionId])
  const verifiedAncestorVersionIds = new Set(knownAncestorVersionIds)
  let expectedState = effect.afterState
  let predecessor: AppliedVenuePackageEffect | LaterContentVersion = effect
  const uncompensated: LaterContentVersion[] = []

  for (const version of laterVersions) {
    if (
      !version.id ||
      seenVersionIds.has(version.id) ||
      version.entityType !== effect.entityType ||
      version.entityId !== effect.entityId ||
      !isJsonValue(version.beforeState) ||
      !isJsonValue(version.afterState)
    ) {
      return failure(
        'MALFORMED_LATER_VERSION',
        `Content version ${version.id || '<missing>'} is malformed.`,
      )
    }
    seenVersionIds.add(version.id)

    if (!venuePackageSnapshotsEqual(version.beforeState, expectedState)) {
      return failure(
        'LINEAGE_MISMATCH',
        `Content version ${version.id} does not continue the preceding snapshot.`,
      )
    }

    if (version.revertedFromId != null) {
      const predecessorId = 'id' in predecessor ? predecessor.id : predecessor.applyVersionId
      const predecessorOperation = predecessor.operation
      const expectedInverseOperation =
        predecessorOperation === 'CREATE'
          ? 'DELETE'
          : predecessorOperation === 'DELETE'
            ? 'CREATE'
            : 'UPDATE'
      if (version.revertedFromId === predecessorId) {
        if (
          version.operation !== expectedInverseOperation ||
          !venuePackageSnapshotsEqual(version.beforeState, predecessor.afterState) ||
          !venuePackageSnapshotsEqual(version.afterState, predecessor.beforeState)
        ) {
          return failure(
            'LINEAGE_MISMATCH',
            `Revert version ${version.id} is not an exact inverse of its immediate predecessor.`,
          )
        }
        if (predecessor === effect) {
          return failure(
            'LATER_CHANGE_CONFLICT',
            'The package effect has already been compensated by a later revert.',
          )
        }
        if (uncompensated.at(-1) !== predecessor) {
          return failure('LINEAGE_MISMATCH', `Revert version ${version.id} has malformed lineage.`)
        }
        uncompensated.pop()
      } else {
        if (
          version.revertedFromId === version.id ||
          (!seenVersionIds.has(version.revertedFromId) &&
            !verifiedAncestorVersionIds.has(version.revertedFromId)) ||
          !transitionIsWellFormed(version.operation, version.beforeState, version.afterState)
        ) {
          return failure('LINEAGE_MISMATCH', `Revert version ${version.id} has malformed lineage.`)
        }
        // A field-local package revert may compensate a non-adjacent ancestor
        // while preserving disjoint later work. Treat that transition as a
        // normal later change for overlap analysis rather than folding it.
        uncompensated.push(version)
      }
    } else {
      if (!transitionIsWellFormed(version.operation, version.beforeState, version.afterState)) {
        return failure(
          'MALFORMED_LATER_VERSION',
          `Content version ${version.id} has invalid action snapshots.`,
        )
      }
      uncompensated.push(version)
    }

    expectedState = version.afterState
    predecessor = version
  }

  if (!venuePackageSnapshotsEqual(currentState, expectedState)) {
    return failure(
      'CURRENT_STATE_MISMATCH',
      'The current snapshot does not match the end of the supplied version lineage.',
    )
  }

  if (effect.operation === 'CREATE') {
    if (uncompensated.length > 0) {
      return failure('LATER_CHANGE_CONFLICT', 'A created entity has uncompensated later changes.')
    }
    if (!isSnapshot(effect.afterState) || !isSnapshot(currentState)) {
      return failure('CURRENT_STATE_MISMATCH', 'The created entity is no longer present.')
    }
    return { ok: true, plan: { operation: 'DELETE', expectedState: effect.afterState } }
  }

  if (effect.operation === 'DELETE') {
    if (uncompensated.length > 0) {
      return failure('LATER_CHANGE_CONFLICT', 'A deleted entity has uncompensated later changes.')
    }
    if (!isSnapshot(effect.beforeState) || currentState !== null) {
      return failure('CURRENT_STATE_MISMATCH', 'The deleted entity has been recreated or changed.')
    }
    return { ok: true, plan: { operation: 'CREATE', state: effect.beforeState } }
  }

  if (
    !isSnapshot(effect.beforeState) ||
    !isSnapshot(effect.afterState) ||
    !isSnapshot(currentState)
  ) {
    return failure('CURRENT_STATE_MISMATCH', 'The updated entity is no longer present.')
  }

  const effectFields = changedFields(effect.beforeState, effect.afterState)
  for (const field of effectFields) {
    if (IMMUTABLE_PATCH_FIELDS.has(field)) {
      return failure('MALFORMED_APPLIED_EFFECT', `Package effect changes immutable field ${field}.`)
    }
  }

  for (const version of uncompensated) {
    if (
      version.operation !== 'UPDATE' ||
      !isSnapshot(version.beforeState) ||
      !isSnapshot(version.afterState)
    ) {
      return failure('LATER_CHANGE_CONFLICT', 'A later create or delete prevents update rollback.')
    }
    const overlap = [...changedFields(version.beforeState, version.afterState)].filter((field) =>
      effectFields.has(field),
    )
    if (overlap.length > 0) {
      return failure(
        'OVERLAPPING_UPDATE',
        `Later content changes overlap package fields: ${overlap.sort().join(', ')}.`,
      )
    }
  }

  for (const field of effectFields) {
    const afterHasField = Object.prototype.hasOwnProperty.call(effect.afterState, field)
    const currentHasField = Object.prototype.hasOwnProperty.call(currentState, field)
    if (
      afterHasField !== currentHasField ||
      (afterHasField && !venuePackageSnapshotsEqual(currentState[field], effect.afterState[field]))
    ) {
      return failure(
        'CURRENT_STATE_MISMATCH',
        `Current field ${field} no longer matches the applied package state.`,
      )
    }
  }

  const fields: JsonSnapshot = {}
  const expectedFields: JsonSnapshot = {}
  const unsetFields: string[] = []
  const expectedUnsetFields: string[] = []
  for (const field of [...effectFields].sort()) {
    if (Object.prototype.hasOwnProperty.call(effect.beforeState, field))
      fields[field] = effect.beforeState[field]
    else unsetFields.push(field)

    if (Object.prototype.hasOwnProperty.call(effect.afterState, field)) {
      expectedFields[field] = effect.afterState[field]
    } else {
      expectedUnsetFields.push(field)
    }
  }

  return {
    ok: true,
    plan: { operation: 'PATCH', fields, unsetFields, expectedFields, expectedUnsetFields },
  }
}
