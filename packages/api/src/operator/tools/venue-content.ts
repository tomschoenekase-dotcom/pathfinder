import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { changesetProblems, resolveChangeset } from '../content-changeset'
import {
  legacyAudience,
  pointerServesGuests,
  readPublishedPointers,
  TYPED_RELATIONS,
  typedFieldsOf,
  typedLifecycle,
  typedTitleOf,
  untrusted,
  type PublishedPointer,
} from '../content-view'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { pageResult, requireCursorInScope } from './page'

const PAGE_SIZE = 25

type ContentRowView = {
  representation: 'LEGACY_PLACE' | 'LEGACY_KNOWLEDGE' | 'TYPED_REVISION'
  kind: string
  id: string
  title: ReturnType<typeof untrusted>
  revision: string
  revisionKind: 'updatedAt' | 'version'
  updatedAt: string
  audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR' | 'SECOND_LAYER'
  guestVisible: boolean
  lifecycle: 'ACTIVE' | 'RETIRED' | 'SCHEDULED' | 'ENDED'
  effectiveFrom: string | null
  effectiveUntil: string | null
  publishedPointer: { moduleRevisionId: string; version: number; publicationId: string } | null
}

const pointerView = (pointer: PublishedPointer | undefined) =>
  pointer
    ? {
        moduleRevisionId: pointer.moduleRevisionId,
        version: pointer.version,
        publicationId: pointer.publicationId,
      }
    : null

type TypedIdentity = {
  id: string
  kind: string
  revisions: Array<
    {
      id: string
      version: number
      audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR'
      effectiveFrom: Date | null
      effectiveUntil: Date | null
      createdAt: Date
    } & Record<string, unknown>
  >
}

function typedRow(
  identity: TypedIdentity,
  pointer: PublishedPointer | undefined,
  now: Date,
): ContentRowView {
  const latest = identity.revisions[0]!
  const fields = typedFieldsOf(latest as never)
  return {
    representation: 'TYPED_REVISION',
    kind: identity.kind,
    id: identity.id,
    title: untrusted(typedTitleOf(fields), 200),
    revision: String(latest.version),
    revisionKind: 'version',
    updatedAt: latest.createdAt.toISOString(),
    audience: latest.audience,
    // Guests are served a typed revision only through its latest publication event, and only
    // while that published revision is public and inside its effective window.
    guestVisible: pointerServesGuests(pointer, now),
    lifecycle: typedLifecycle(latest, now),
    effectiveFrom: latest.effectiveFrom?.toISOString() ?? null,
    effectiveUntil: latest.effectiveUntil?.toISOString() ?? null,
    publishedPointer: pointerView(pointer),
  }
}

const typedSelect = {
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
      createdAt: true,
      ...TYPED_RELATIONS,
    },
  },
} as const

const venuesListContent: OperatorReadTool = {
  name: 'venues.list_content',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.list_content'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const limit = Math.min(input.limit, PAGE_SIZE)
    const cursorArgs = input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}
    const now = context.now
    if (input.representation === 'LEGACY_PLACE') {
      await requireCursorInScope(input.cursor, (id) =>
        context.database.place.findFirst({ where: { id, ...scope }, select: { id: true } }),
      )
      const rows = await context.database.place.findMany({
        where: scope,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...cursorArgs,
        select: { id: true, name: true, isActive: true, visibility: true, updatedAt: true },
      })
      const page = rows.slice(0, limit)
      return pageResult(
        page.map(
          (row): ContentRowView => ({
            representation: 'LEGACY_PLACE',
            kind: 'PLACE',
            id: row.id,
            title: untrusted(row.name, 200),
            revision: row.updatedAt.toISOString(),
            revisionKind: 'updatedAt',
            updatedAt: row.updatedAt.toISOString(),
            audience: legacyAudience(row.visibility),
            guestVisible: row.isActive && row.visibility === 'PUBLIC',
            lifecycle: row.isActive ? 'ACTIVE' : 'RETIRED',
            effectiveFrom: null,
            effectiveUntil: null,
            publishedPointer: null,
          }),
        ),
        rows.length > limit ? page.at(-1)!.id : null,
      )
    }
    if (input.representation === 'LEGACY_KNOWLEDGE') {
      await requireCursorInScope(input.cursor, (id) =>
        context.database.venueKnowledgeEntry.findFirst({
          where: { id, ...scope },
          select: { id: true },
        }),
      )
      const rows = await context.database.venueKnowledgeEntry.findMany({
        where: scope,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...cursorArgs,
        select: { id: true, title: true, isEnabled: true, visibility: true, updatedAt: true },
      })
      const page = rows.slice(0, limit)
      return pageResult(
        page.map(
          (row): ContentRowView => ({
            representation: 'LEGACY_KNOWLEDGE',
            kind: 'KNOWLEDGE',
            id: row.id,
            title: untrusted(row.title, 200),
            revision: row.updatedAt.toISOString(),
            revisionKind: 'updatedAt',
            updatedAt: row.updatedAt.toISOString(),
            audience: legacyAudience(row.visibility),
            guestVisible: row.isEnabled && row.visibility === 'PUBLIC',
            lifecycle: row.isEnabled ? 'ACTIVE' : 'RETIRED',
            effectiveFrom: null,
            effectiveUntil: null,
            publishedPointer: null,
          }),
        ),
        rows.length > limit ? page.at(-1)!.id : null,
      )
    }
    await requireCursorInScope(input.cursor, (id) =>
      context.database.contentModuleIdentity.findFirst({
        where: { id, ...scope },
        select: { id: true },
      }),
    )
    const identities = await context.database.contentModuleIdentity.findMany({
      where: scope,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...cursorArgs,
      select: typedSelect,
    })
    const page = identities.slice(0, limit).filter((identity) => identity.revisions.length > 0)
    const pointers = await readPublishedPointers(
      context.database,
      scope,
      page.map((identity) => identity.id),
    )
    return pageResult(
      page.map((identity) => typedRow(identity as never, pointers.get(identity.id), now)),
      identities.length > limit ? identities.slice(0, limit).at(-1)!.id : null,
    )
  },
}

const venuesGetContent: OperatorReadTool = {
  name: 'venues.get_content',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_content'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const now = context.now
    if (input.representation === 'LEGACY_PLACE') {
      const row = await context.database.place.findFirst({
        where: { id: input.id, ...scope },
      })
      if (!row) throw new OperatorNotFoundError()
      const fields: Array<[string, string | null]> = [
        ['name', row.name],
        ['type', row.type],
        ['itemType', row.itemType],
        ['shortDescription', row.shortDescription],
        ['longDescription', row.longDescription],
        ['hours', row.hours],
        ['areaName', row.areaName],
        ['tags', row.tags.join(', ')],
      ]
      return {
        content: {
          representation: 'LEGACY_PLACE' as const,
          kind: 'PLACE',
          id: row.id,
          title: untrusted(row.name, 200),
          revision: row.updatedAt.toISOString(),
          revisionKind: 'updatedAt' as const,
          updatedAt: row.updatedAt.toISOString(),
          audience: legacyAudience(row.visibility),
          guestVisible: row.isActive && row.visibility === 'PUBLIC',
          lifecycle: row.isActive ? ('ACTIVE' as const) : ('RETIRED' as const),
          effectiveFrom: null,
          effectiveUntil: null,
          publishedPointer: null,
        },
        fields: fields
          .filter(([, value]) => value !== null && value !== '')
          .map(([name, value]) => ({ name, value: untrusted(value, 20_000) })),
        evidence: [],
        provenance: {
          sourceType: row.sourceType,
          authorship: row.authorship,
          sourceName: row.sourceName ? untrusted(row.sourceName, 200) : null,
          sourceUrl: row.sourceUrl,
          sourcePackageId: row.sourcePackageId,
        },
        revisions: [],
        projectedFromModuleId: null,
      }
    }
    if (input.representation === 'LEGACY_KNOWLEDGE') {
      const row = await context.database.venueKnowledgeEntry.findFirst({
        where: { id: input.id, ...scope },
      })
      if (!row) throw new OperatorNotFoundError()
      return {
        content: {
          representation: 'LEGACY_KNOWLEDGE' as const,
          kind: 'KNOWLEDGE',
          id: row.id,
          title: untrusted(row.title, 200),
          revision: row.updatedAt.toISOString(),
          revisionKind: 'updatedAt' as const,
          updatedAt: row.updatedAt.toISOString(),
          audience: legacyAudience(row.visibility),
          guestVisible: row.isEnabled && row.visibility === 'PUBLIC',
          lifecycle: row.isEnabled ? ('ACTIVE' as const) : ('RETIRED' as const),
          effectiveFrom: null,
          effectiveUntil: null,
          publishedPointer: null,
        },
        fields: [
          { name: 'title', value: untrusted(row.title, 20_000) },
          { name: 'category', value: untrusted(row.category, 20_000) },
          { name: 'content', value: untrusted(row.content, 20_000) },
        ],
        evidence: [],
        provenance: {
          sourceType: row.sourceType,
          authorship: row.authorship,
          sourceName: row.sourceName ? untrusted(row.sourceName, 200) : null,
          sourceUrl: row.sourceUrl,
          sourcePackageId: row.sourcePackageId,
        },
        revisions: [],
        projectedFromModuleId: row.contentModuleId,
      }
    }
    const identity = await context.database.contentModuleIdentity.findFirst({
      where: { id: input.id, ...scope },
      select: {
        ...typedSelect,
        revisions: {
          orderBy: { version: 'desc' },
          take: 20,
          select: {
            id: true,
            version: true,
            audience: true,
            effectiveFrom: true,
            effectiveUntil: true,
            createdAt: true,
            ...TYPED_RELATIONS,
            evidence: {
              orderBy: { capturedAt: 'desc' },
              take: 100,
              select: { sourceId: true, locator: true, capturedAt: true, excerptHash: true },
            },
          },
        },
      },
    })
    if (!identity || identity.revisions.length === 0) throw new OperatorNotFoundError()
    const pointers = await readPublishedPointers(context.database, scope, [identity.id])
    const latest = identity.revisions[0]!
    const fields = typedFieldsOf(latest as never)
    return {
      content: typedRow(identity as never, pointers.get(identity.id), now),
      fields: Object.entries(fields)
        .filter(([, value]) => value !== null)
        .slice(0, 30)
        .map(([name, value]) => ({ name, value: untrusted(value, 20_000) })),
      evidence: latest.evidence.map((entry) => ({
        sourceId: entry.sourceId,
        locator: entry.locator,
        capturedAt: entry.capturedAt.toISOString(),
        excerptHash: entry.excerptHash,
      })),
      provenance: null,
      revisions: identity.revisions.map((revision) => ({
        revisionId: revision.id,
        version: revision.version,
        audience: revision.audience,
        createdAt: revision.createdAt.toISOString(),
      })),
      projectedFromModuleId: null,
    }
  },
}

const venuesPreviewContentChangeset: OperatorReadTool = {
  name: 'venues.preview_content_changeset',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.preview_content_changeset'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const resolved = await resolveChangeset(context.database, input, context.now)
    const show = (value: string | null) => (value === null ? null : untrusted(value, 2_000))
    return {
      venueId: input.venueId,
      expectedVersion: resolved.expectedVersion,
      currentVersion: resolved.currentVersion,
      stale: resolved.ops.some((op) => op.stale),
      applicable: changesetProblems(resolved).length === 0,
      ops: resolved.ops.map((op) => ({
        index: op.index,
        op: op.op,
        representation: op.representation,
        targetId: op.targetId,
        expectedRevision: op.expectedRevision,
        currentRevision: op.currentRevision,
        stale: op.stale,
        changes: op.changes.slice(0, 30).map((entry) => ({
          field: entry.field,
          before: show(entry.before),
          after: show(entry.after),
        })),
        problems: op.problems.slice(0, 10).map((problem) => problem.slice(0, 300)),
        notes: op.notes.slice(0, 10).map((note) => note.slice(0, 300)),
      })),
    }
  },
}

export const venueContentReadTools: readonly OperatorReadTool[] = [
  venuesListContent,
  venuesGetContent,
  venuesPreviewContentChangeset,
]
