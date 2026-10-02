import { createHash } from 'node:crypto'

import { isFeatureEnabled } from '@pathfinder/config/feature-flags'
import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import type { ContentChangesetOp } from '@pathfinder/contracts/operator-venue-content'
import {
  GeneralizedContentRevisionDraft,
  type GeneralizedContentPayload,
} from '@pathfinder/contracts/universal-content-actions'
import {
  addUniversalContentRevisionAction,
  createLegacyKnowledgeAction,
  createUniversalContentAction,
  LegacyContentActionError,
  retireLegacyKnowledgeAction,
  retireLegacyPlaceAction,
  retireUniversalContentAction,
  UniversalContentActionError,
  updateLegacyKnowledgeAction,
  updateLegacyPlaceAction,
  withdrawUniversalContentAction,
} from '@pathfinder/db'

import type { OperatorDatabase } from './audit'
import {
  flattenTyped,
  normalizeLegacyRevision,
  readPublishedPointers,
  TYPED_RELATIONS,
  typedFieldsOf,
  untrusted,
  type Fields,
} from './content-view'
import { OperatorStaleError, type OperatorApplyContext, derivedOperationId } from './proposals'

/**
 * The correction changeset. One approval can create, update or retire venue content. A correction
 * changes or retires the row it corrects instead of adding a second, contradicting one, every
 * operation names the revision it expects, and a changeset whose expectations no longer hold is
 * refused before anything is written. It never changes an audience, never publishes, and never
 * touches a row it does not name.
 */

export type ChangesetScope = { tenantId: string; venueId: string; ops: ContentChangesetOp[] }

export type ChangesetChange = { field: string; before: string | null; after: string | null }

export type ResolvedOp = {
  index: number
  op: 'create' | 'update' | 'retire'
  representation: ContentChangesetOp['representation']
  targetId: string | null
  expectedRevision: string | null
  currentRevision: string | null
  stale: boolean
  changes: ChangesetChange[]
  problems: string[]
  notes: string[]
  /** Frozen evidence for typed ops, resolved from the cited source snapshots. */
  evidence: Array<{ sourceId: string; locator?: string; capturedAt: string; excerptHash?: string }>
  /** Typed ops: the published revision a retire must withdraw. */
  publishedRevisionId: string | null
}

export type ResolvedChangeset = {
  ops: ResolvedOp[]
  expectedVersion: string
  currentVersion: string
}

export class ChangesetRefusal extends Error {
  readonly code: 'CHANGESET_INVALID' | 'GENERALIZED_CONTENT_DISABLED'
  constructor(code: ChangesetRefusal['code'], message: string) {
    super(message)
    this.code = code
  }
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function opRevision(op: ContentChangesetOp): string | null {
  if (!('expectedRevision' in op)) return null
  return op.representation === 'TYPED_REVISION'
    ? op.expectedRevision.trim()
    : normalizeLegacyRevision(op.expectedRevision)
}

/** The version the proposer expects, from the arguments alone: what each named row looked like. */
export function expectedChangesetVersion(ops: readonly ContentChangesetOp[]): string {
  return sha256(
    ops.flatMap((op) => ('id' in op ? [[op.representation, op.id, opRevision(op)]] : [])),
  )
}

function change(field: string, before: string | null, after: string | null): ChangesetChange {
  return { field, before, after }
}

function diff(before: Fields, after: Fields): ChangesetChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return keys
    .filter((key) => (before[key] ?? null) !== (after[key] ?? null))
    .map((key) => change(key, before[key] ?? null, after[key] ?? null))
}

const KNOWLEDGE_DEFAULT_CATEGORY = 'General'

function blankOp(index: number, op: ContentChangesetOp): ResolvedOp {
  return {
    index,
    op: op.op,
    representation: op.representation,
    targetId: 'id' in op ? op.id : null,
    expectedRevision: opRevision(op),
    currentRevision: null,
    stale: false,
    changes: [],
    problems: [],
    notes: [],
    evidence: [],
    publishedRevisionId: null,
  }
}

async function resolveEvidence(
  database: OperatorDatabase,
  scope: { tenantId: string; venueId: string },
  op: Extract<ContentChangesetOp, { representation: 'TYPED_REVISION' }>,
  resolved: ResolvedOp,
) {
  for (const reference of op.evidence ?? []) {
    const input = await database.venueSourceInput.findFirst({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        sourceId: reference.sourceId,
        ordinal: reference.ordinal,
      },
      select: { retrievedAt: true, contentHash: true, disposition: true },
    })
    if (!input) {
      resolved.problems.push(
        `Evidence ${reference.sourceId}#${reference.ordinal} is not a source input in this venue. Read it with venues.get_source.`,
      )
    } else if (input.disposition !== 'SUCCEEDED' && input.disposition !== 'PARTIAL') {
      resolved.problems.push(
        `Evidence ${reference.sourceId}#${reference.ordinal} has no captured text (${input.disposition.toLowerCase()}). Cite an input that succeeded.`,
      )
    } else {
      resolved.evidence.push({
        sourceId: `venue-source:${reference.sourceId}#${reference.ordinal}`,
        ...(reference.locator ? { locator: reference.locator } : {}),
        capturedAt: input.retrievedAt.toISOString(),
        ...(input.contentHash ? { excerptHash: input.contentHash } : {}),
      })
    }
  }
}

function draftFor(
  op: Extract<ContentChangesetOp, { representation: 'TYPED_REVISION' }>,
  evidence: ResolvedOp['evidence'],
) {
  const draft = 'draft' in op ? op.draft : null
  if (!draft) return null
  return GeneralizedContentRevisionDraft.safeParse({
    audience: draft.audience,
    effectiveFrom: draft.effectiveFrom ?? null,
    effectiveUntil: draft.effectiveUntil ?? null,
    evidence,
    payload: draft.payload,
  })
}

async function referencesExist(
  database: OperatorDatabase,
  scope: { tenantId: string; venueId: string },
  payload: GeneralizedContentPayload,
  resolved: ResolvedOp,
) {
  if (
    (payload.kind === 'ITEM' || payload.kind === 'SERVICE' || payload.kind === 'EVENT') &&
    payload.placeId
  ) {
    const place = await database.place.findFirst({
      where: { id: payload.placeId, tenantId: scope.tenantId, venueId: scope.venueId },
      select: { id: true },
    })
    if (!place) resolved.problems.push('The referenced place does not exist in this venue.')
  }
  if (payload.kind === 'RELATIONSHIP') {
    const ends = await database.contentModuleIdentity.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        id: { in: [payload.fromModuleId, payload.toModuleId] },
      },
    })
    if (ends !== 2) {
      resolved.problems.push('Both relationship endpoints must be modules in this venue.')
    }
  }
}

/**
 * Reads the current state of every row the changeset names and computes, without writing, what
 * each operation would change, whether its expected revision still holds, and why it could not
 * apply. This is the single source for the preview read, the proposal checks and the approval view.
 */
export async function resolveChangeset(
  database: OperatorDatabase,
  args: ChangesetScope,
  now: Date,
): Promise<ResolvedChangeset> {
  const scope = { tenantId: args.tenantId, venueId: args.venueId }
  const retiringKnowledge = new Set(
    args.ops.flatMap((op) =>
      op.op === 'retire' && op.representation === 'LEGACY_KNOWLEDGE' ? [op.id] : [],
    ),
  )
  const resolvedOps: ResolvedOp[] = []
  for (const [index, op] of args.ops.entries()) {
    const resolved = blankOp(index, op)
    resolvedOps.push(resolved)
    if (op.representation === 'LEGACY_KNOWLEDGE') {
      if (op.op === 'create') {
        const clash = await database.venueKnowledgeEntry.findMany({
          where: {
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            isEnabled: true,
            title: { equals: op.title, mode: 'insensitive' },
          },
          select: { id: true, updatedAt: true },
          take: 5,
        })
        const unresolved = clash.filter((row) => !retiringKnowledge.has(row.id))
        for (const row of unresolved) {
          resolved.problems.push(
            `An enabled entry titled "${op.title}" already exists (${row.id}, revision ${row.updatedAt.toISOString()}). Update or retire it in this changeset instead of adding a contradicting entry.`,
          )
        }
        resolved.changes = [
          change('title', null, op.title),
          change('body', null, op.body),
          change('category', null, op.category ?? KNOWLEDGE_DEFAULT_CATEGORY),
        ]
        resolved.notes.push('New entries are public: guests can be told this once it is saved.')
        continue
      }
      const row = await database.venueKnowledgeEntry.findFirst({
        where: { id: op.id, tenantId: scope.tenantId, venueId: scope.venueId },
        select: {
          id: true,
          title: true,
          category: true,
          content: true,
          isEnabled: true,
          visibility: true,
          updatedAt: true,
          contentModuleId: true,
        },
      })
      if (!row) {
        resolved.problems.push('This knowledge entry does not exist in this venue.')
        continue
      }
      resolved.currentRevision = row.updatedAt.toISOString()
      resolved.stale = resolved.currentRevision !== resolved.expectedRevision
      if (resolved.stale) {
        resolved.problems.push(
          `Stale: the entry is at revision ${resolved.currentRevision}, not ${resolved.expectedRevision}. Read it again with venues.get_content.`,
        )
      }
      if (row.contentModuleId) {
        resolved.problems.push(
          `This entry is projected from typed module ${row.contentModuleId}. Change the module (representation TYPED_REVISION), not the projected row.`,
        )
      }
      if (!row.isEnabled) {
        resolved.problems.push(
          op.op === 'retire'
            ? 'This entry is already retired.'
            : 'This entry is retired. Create a new entry or ask a person to re-enable it.',
        )
      }
      if (row.visibility !== 'PUBLIC') {
        resolved.notes.push(
          'This entry is employee-only (second layer). Its audience is not changed and it stays hidden from public guests.',
        )
      }
      if (op.op === 'update') {
        const before: Fields = { title: row.title, body: row.content, category: row.category }
        const after: Fields = {
          title: op.title ?? row.title,
          body: op.body ?? row.content,
          category: op.category ?? row.category,
        }
        resolved.changes = diff(before, after)
      } else {
        resolved.changes = [change('isEnabled', 'true', 'false')]
        resolved.notes.push(
          'The entry is retired, not deleted: guests stop being told it and its history is kept.',
        )
      }
      continue
    }
    if (op.representation === 'LEGACY_PLACE') {
      const row = await database.place.findFirst({
        where: { id: op.id, tenantId: scope.tenantId, venueId: scope.venueId },
        select: {
          id: true,
          name: true,
          shortDescription: true,
          longDescription: true,
          hours: true,
          areaName: true,
          isActive: true,
          visibility: true,
          updatedAt: true,
        },
      })
      if (!row) {
        resolved.problems.push('This place does not exist in this venue.')
        continue
      }
      resolved.currentRevision = row.updatedAt.toISOString()
      resolved.stale = resolved.currentRevision !== resolved.expectedRevision
      if (resolved.stale) {
        resolved.problems.push(
          `Stale: the place is at revision ${resolved.currentRevision}, not ${resolved.expectedRevision}. Read it again with venues.get_content.`,
        )
      }
      if (!row.isActive) {
        resolved.problems.push(
          op.op === 'retire' ? 'This place is already retired.' : 'This place is retired.',
        )
      }
      if (row.visibility !== 'PUBLIC') {
        resolved.notes.push(
          'This place is employee-only (second layer). Its audience is not changed.',
        )
      }
      if (op.op === 'update') {
        const before: Fields = {
          name: row.name,
          shortDescription: row.shortDescription,
          longDescription: row.longDescription,
          hours: row.hours,
          areaName: row.areaName,
        }
        const after: Fields = { ...before }
        for (const key of [
          'name',
          'shortDescription',
          'longDescription',
          'hours',
          'areaName',
        ] as const) {
          if (op[key] !== undefined) after[key] = op[key] ?? null
        }
        resolved.changes = diff(before, after)
      } else {
        resolved.changes = [change('isActive', 'true', 'false')]
        const referencing =
          (await database.serviceContent.count({ where: { ...scope, placeId: op.id } })) +
          (await database.itemContent.count({ where: { ...scope, placeId: op.id } })) +
          (await database.eventContent.count({ where: { ...scope, placeId: op.id } }))
        if (referencing > 0) {
          resolved.notes.push(
            `${referencing} typed content revision(s) still reference this place. Retire or update them too if they should not outlive it.`,
          )
        }
      }
      continue
    }
    // Typed revisions.
    if (!isFeatureEnabled('generalizedContentCapabilities')) {
      resolved.problems.push(
        'Typed content authoring is disabled for this deployment (generalizedContentCapabilities). Use legacy knowledge or places, or ask a person to enable it.',
      )
      continue
    }
    await resolveEvidence(database, scope, op as never, resolved)
    if (op.op === 'create') {
      const parsed = draftFor(op, resolved.evidence)
      if (!parsed?.success) {
        resolved.problems.push(
          `The draft is invalid: ${parsed?.error.issues[0]?.message ?? 'unreadable'}.`,
        )
        continue
      }
      await referencesExist(database, scope, parsed.data.payload, resolved)
      resolved.changes = Object.entries(flattenTyped(parsed.data.payload as never))
        .filter(([, value]) => value !== null)
        .map(([field, value]) => change(field, null, value))
      resolved.changes.push(change('audience', null, parsed.data.audience))
      resolved.notes.push(
        `Authored as a ${parsed.data.audience} draft. It is not published, so guests see nothing until a person publishes it.`,
      )
      continue
    }
    const identity = await database.contentModuleIdentity.findFirst({
      where: { id: op.id, tenantId: scope.tenantId, venueId: scope.venueId },
      select: {
        id: true,
        kind: true,
        revisions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: {
            id: true,
            version: true,
            audience: true,
            effectiveFrom: true,
            effectiveUntil: true,
            ...TYPED_RELATIONS,
          },
        },
      },
    })
    const latest = identity?.revisions[0]
    if (!identity || !latest) {
      resolved.problems.push('This content module does not exist in this venue.')
      continue
    }
    resolved.currentRevision = String(latest.version)
    resolved.stale = resolved.currentRevision !== resolved.expectedRevision
    if (resolved.stale) {
      resolved.problems.push(
        `Stale: the module is at version ${resolved.currentRevision}, not ${resolved.expectedRevision}. Read it again with venues.get_content.`,
      )
    }
    const pointer = (await readPublishedPointers(database, scope, [identity.id])).get(identity.id)
    resolved.publishedRevisionId = pointer?.moduleRevisionId ?? null
    const before = typedFieldsOf(latest as never)
    if (op.op === 'update') {
      const parsed = draftFor(op, resolved.evidence)
      if (!parsed?.success) {
        resolved.problems.push(
          `The draft is invalid: ${parsed?.error.issues[0]?.message ?? 'unreadable'}.`,
        )
        continue
      }
      if (parsed.data.payload.kind !== identity.kind) {
        resolved.problems.push(
          `A ${identity.kind} module cannot become ${parsed.data.payload.kind}.`,
        )
      }
      if (parsed.data.audience !== latest.audience) {
        resolved.problems.push(
          `The audience cannot change in a correction (${latest.audience} to ${parsed.data.audience}). Widening who may see content is a separate decision for a person.`,
        )
      }
      await referencesExist(database, scope, parsed.data.payload, resolved)
      const after = flattenTyped(parsed.data.payload as never)
      resolved.changes = diff(before, after)
      if (pointer) {
        resolved.notes.push(
          `Guests keep seeing published version ${pointer.version} until the new revision is published through the publication path. This changeset does not publish.`,
        )
      }
    } else {
      const until = new Date(op.effectiveUntil)
      if (latest.effectiveFrom && until <= latest.effectiveFrom) {
        resolved.problems.push('The end time must be after the module starts.')
      }
      if (latest.effectiveUntil && latest.effectiveUntil <= now) {
        resolved.problems.push('This module has already ended.')
      }
      resolved.changes = [
        change('effectiveUntil', latest.effectiveUntil?.toISOString() ?? null, until.toISOString()),
      ]
      if (pointer) {
        resolved.changes.push(
          change('publication', `published (version ${pointer.version})`, 'withdrawn'),
        )
        resolved.notes.push(
          'Applying also withdraws the live publication, so guests stop being told this immediately.',
        )
      }
    }
  }
  const currentVersion = sha256(
    resolvedOps.flatMap((op) =>
      op.targetId !== null ? [[op.representation, op.targetId, op.currentRevision]] : [],
    ),
  )
  return { ops: resolvedOps, expectedVersion: expectedChangesetVersion(args.ops), currentVersion }
}

export function changesetProblems(resolved: ResolvedChangeset): string[] {
  return resolved.ops.flatMap((op) =>
    op.problems.map(
      (problem) => `Operation ${op.index + 1} (${op.op} ${op.representation}): ${problem}`,
    ),
  )
}

/** One line per operation for the approval page; the exact values are in the computed diff. */
export function describeChangeset(ops: readonly ContentChangesetOp[]): string[] {
  return ops.map((op, index) => {
    const target = 'id' in op ? ` ${op.id} (expects ${opRevision(op)})` : ''
    const detail =
      op.representation === 'LEGACY_KNOWLEDGE' && op.op !== 'retire'
        ? ` — ${[
            'title' in op && op.title ? `title: ${op.title}` : null,
            'body' in op && op.body ? `body: ${op.body}` : null,
            'category' in op && op.category ? `category: ${op.category}` : null,
          ]
            .filter(Boolean)
            .join('; ')}`
        : ''
    return `${index + 1}. ${op.op.toUpperCase()} ${op.representation}${target}${detail}`
  })
}

/** The computed diff as flat before/after fields for the approval page. */
export async function pendingChangesetChanges(
  database: OperatorDatabase,
  args: ChangesetScope,
  now: Date,
) {
  const resolved = await resolveChangeset(database, args, now)
  return resolved.ops.flatMap((op) =>
    op.changes.map((entry) => ({
      field: `${op.index + 1}. ${op.op} ${op.targetId ?? 'new'} · ${entry.field}`,
      before: untrusted(entry.before, 300).text || 'none',
      after: untrusted(entry.after, 300).text || 'none',
    })),
  )
}

function stale(message: string): never {
  throw new OperatorStaleError(message)
}

function translate(error: unknown): never {
  if (
    (error instanceof LegacyContentActionError || error instanceof UniversalContentActionError) &&
    error.code === 'CONFLICT'
  ) {
    return stale(error.message)
  }
  throw error
}

type TransactionalClient = Pick<OperatorDatabase, '$transaction'>

/**
 * Applies the whole changeset in one transaction through the canonical content actions, which
 * re-check every expected revision under their own locks. Either every operation applies or none
 * does, so a correction can never half-apply and leave a contradiction behind.
 */
export async function applyChangeset(
  args: ChangesetScope,
  context: OperatorApplyContext,
): Promise<{ result: Record<string, JsonValue>; after: JsonValue }> {
  const resolved = await resolveChangeset(context.database, args, context.now)
  const problems = changesetProblems(resolved)
  if (problems.length > 0) {
    if (resolved.ops.some((op) => op.stale)) return stale(problems[0]!)
    throw new ChangesetRefusal('CHANGESET_INVALID', problems[0]!)
  }
  const actor = context.actor
  const applied: JsonValue[] = []
  try {
    await context.database.$transaction(
      async (tx) => {
        const client: TransactionalClient = {
          $transaction: ((run: (inner: typeof tx) => unknown) =>
            run(tx)) as unknown as TransactionalClient['$transaction'],
        }
        for (const [index, op] of args.ops.entries()) {
          const entry = resolved.ops[index]!
          const base = { tenantId: args.tenantId, venueId: args.venueId, actor }
          if (op.representation === 'LEGACY_KNOWLEDGE') {
            if (op.op === 'create') {
              const row = await createLegacyKnowledgeAction(
                {
                  ...base,
                  fields: {
                    title: op.title,
                    category: op.category ?? KNOWLEDGE_DEFAULT_CATEGORY,
                    content: op.body,
                    isEnabled: true,
                  },
                },
                client,
              )
              applied.push({
                index,
                op: 'create',
                representation: op.representation,
                id: row.id,
                revision: row.updatedAt.toISOString(),
              })
            } else if (op.op === 'update') {
              const row = await updateLegacyKnowledgeAction(
                {
                  ...base,
                  id: op.id,
                  expectedUpdatedAt: new Date(entry.expectedRevision!),
                  // Audience (visibility) is never part of a correction.
                  fields: {
                    ...(op.title !== undefined ? { title: op.title } : {}),
                    ...(op.body !== undefined ? { content: op.body } : {}),
                    ...(op.category !== undefined ? { category: op.category } : {}),
                  },
                },
                client,
              )
              applied.push({
                index,
                op: 'update',
                representation: op.representation,
                id: row.id,
                revision: row.updatedAt.toISOString(),
              })
            } else {
              const row = await retireLegacyKnowledgeAction(
                { ...base, id: op.id, expectedUpdatedAt: new Date(entry.expectedRevision!) },
                client,
              )
              applied.push({
                index,
                op: 'retire',
                representation: op.representation,
                id: row.id,
                revision: row.updatedAt.toISOString(),
              })
            }
          } else if (op.representation === 'LEGACY_PLACE') {
            if (op.op === 'update') {
              const row = await updateLegacyPlaceAction(
                {
                  ...base,
                  id: op.id,
                  expectedUpdatedAt: new Date(entry.expectedRevision!),
                  fields: {
                    ...(op.name !== undefined ? { name: op.name } : {}),
                    ...(op.shortDescription !== undefined
                      ? { shortDescription: op.shortDescription }
                      : {}),
                    ...(op.longDescription !== undefined
                      ? { longDescription: op.longDescription }
                      : {}),
                    ...(op.hours !== undefined ? { hours: op.hours } : {}),
                    ...(op.areaName !== undefined ? { areaName: op.areaName } : {}),
                  },
                },
                client,
              )
              applied.push({
                index,
                op: 'update',
                representation: op.representation,
                id: row.id,
                revision: row.updatedAt.toISOString(),
              })
            } else if (op.op === 'retire') {
              const row = await retireLegacyPlaceAction(
                { ...base, id: op.id, expectedUpdatedAt: new Date(entry.expectedRevision!) },
                client,
              )
              applied.push({
                index,
                op: 'retire',
                representation: op.representation,
                id: row.id,
                revision: row.updatedAt.toISOString(),
              })
            }
          } else if (op.op === 'create') {
            const parsed = draftFor(op, entry.evidence)!
            const draft = parsed.success ? parsed.data : null
            if (!draft) throw new ChangesetRefusal('CHANGESET_INVALID', 'The draft is invalid.')
            const created = await createUniversalContentAction({
              db: client as never,
              ...base,
              moduleId: derivedOperationId(context.operationId, index),
              draft,
            })
            applied.push({
              index,
              op: 'create',
              representation: op.representation,
              id: created.moduleId,
              revision: String(created.version),
            })
          } else if (op.op === 'update') {
            const parsed = draftFor(op, entry.evidence)!
            const draft = parsed.success ? parsed.data : null
            if (!draft) throw new ChangesetRefusal('CHANGESET_INVALID', 'The draft is invalid.')
            const added = await addUniversalContentRevisionAction({
              db: client as never,
              ...base,
              moduleId: op.id,
              expectedLatestVersion: Number(entry.expectedRevision),
              draft,
            })
            applied.push({
              index,
              op: 'update',
              representation: op.representation,
              id: added.moduleId,
              revision: String(added.version),
            })
          } else {
            const retired = await retireUniversalContentAction({
              db: client as never,
              ...base,
              moduleId: op.id,
              expectedLatestVersion: Number(entry.expectedRevision),
              effectiveUntil: op.effectiveUntil,
              evidence: entry.evidence,
            })
            if (entry.publishedRevisionId) {
              await withdrawUniversalContentAction({
                db: client as never,
                ...base,
                moduleId: op.id,
                expectedPublishedRevisionId: entry.publishedRevisionId,
                requestId: derivedOperationId(context.operationId, 1_000 + index),
              })
            }
            applied.push({
              index,
              op: 'retire',
              representation: op.representation,
              id: retired.moduleId,
              revision: String(retired.version),
            })
          }
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    )
  } catch (error) {
    return translate(error)
  }
  return {
    result: { venueId: args.venueId, applied, published: false },
    after: {
      venueId: args.venueId,
      operations: applied,
    } as unknown as JsonValue,
  }
}

/** The current revision of every named row, for the stored snapshot and the staleness check. */
export async function currentChangesetVersion(
  database: OperatorDatabase,
  args: ChangesetScope,
  now: Date,
): Promise<string> {
  return (await resolveChangeset(database, args, now)).currentVersion
}
