import { createHash } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import {
  SOURCE_CONNECTION_PROVIDER,
  SourceConnectionConfigSchema,
  SourceConnectionSnapshotSchema,
  type SourceConnectionRecord,
  type SourceConnectionSnapshot,
} from '@pathfinder/contracts/source-connections'
import {
  sourceConnectionConfigHash,
  sourceConnectionSnapshotHash,
} from '@pathfinder/contracts/source-connections-node'

import { db } from '../client'
import { readAuthorizedSourceHostsAction } from './venue-source-actions'
import { lockVenueContentMutation } from './venue-content-lock'
import { readSourceConnectionPreview, recordSourceConnectionEvidence } from './source-connections'
import { writeAuditLogStrict } from './audit'

type Scope = { tenantId: string; venueId: string; connectorId: string }

function stableId(...parts: string[]) {
  return `sc_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 36)}`
}

function stableUuid(...parts: string[]) {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function recordContent(record: SourceConnectionRecord): string {
  const lines = [record.text]
  if (record.showtimes.length)
    lines.push(
      `Showtimes: ${record.showtimes.map((item) => `${item.startAt}–${item.endAt}`).join('; ')}`,
    )
  if (record.startDate || record.endDate)
    lines.push(`Dates: ${record.startDate ?? '?'} through ${record.endDate ?? '?'}`)
  if (record.cancelled) lines.push('Cancelled')
  return lines.join('\n')
}

/**
 * Narrow scheduler authority: only an ACTIVE connector with an exact human-approved config may
 * publish its own records. This deliberately does not call the human content action or impersonate
 * a human actor. Publication, projection, and the guest snapshot commit under one venue lock.
 */
export async function publishSourceConnectionSnapshot(
  input: Scope & { snapshot: Omit<SourceConnectionSnapshot, 'publicationIds'>; now: Date },
  client: typeof db = db,
): Promise<{
  status: 'PUBLISHED' | 'UNCHANGED' | 'CONFLICT'
  snapshot?: SourceConnectionSnapshot
}> {
  const checked = SourceConnectionSnapshotSchema.safeParse({
    ...input.snapshot,
    publicationIds: [],
  })
  if (
    !checked.success ||
    sourceConnectionSnapshotHash(input.snapshot.records) !== input.snapshot.contentHash
  ) {
    return { status: 'CONFLICT' }
  }
  if (
    new Date(input.snapshot.freshnessExpiresAt) <= input.now ||
    new Date(input.snapshot.observedAt) > input.now
  )
    return { status: 'CONFLICT' }
  return client.$transaction(async (tx) => {
    await lockVenueContentMutation(tx, input)
    const connector = await tx.liveDataConnector.findFirst({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        state: 'ACTIVE',
      },
      select: { mapping: true, endpointUrl: true, lastTestPreview: true, updatedAt: true },
    })
    if (!connector) return { status: 'CONFLICT' as const }
    const parsed = SourceConnectionConfigSchema.safeParse(connector.mapping)
    if (!parsed.success) return { status: 'CONFLICT' as const }
    const config = parsed.data
    const hash = sourceConnectionConfigHash(config)
    if (
      !config.approval ||
      config.approval.approvedConfigHash !== hash ||
      hash !== input.snapshot.configHash ||
      connector.endpointUrl !== input.snapshot.sourceUrl ||
      !config.allowedUrls.includes(input.snapshot.sourceUrl)
    )
      return { status: 'CONFLICT' as const }
    if (
      input.snapshot.records.some(
        (record) =>
          !config.allowedUrls.includes(record.sourceUrl) ||
          record.timezone !== config.timezone ||
          record.links.some((link) => !config.allowedUrls.includes(link)),
      )
    )
      return { status: 'CONFLICT' as const }
    // Acquire the connector row lock and compare its version before writing any content. Pause,
    // config edits and approval changes then serialize with this entire publication transaction.
    const fenced = await tx.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        state: 'ACTIVE',
        updatedAt: connector.updatedAt,
      },
      data: { updatedAt: new Date(Math.max(Date.now(), connector.updatedAt.getTime() + 1)) },
    })
    if (fenced.count !== 1) return { status: 'CONFLICT' as const }
    const originHosts = await readAuthorizedSourceHostsAction(input, tx)
    if (!originHosts.includes(new URL(input.snapshot.sourceUrl).hostname.toLowerCase()))
      return { status: 'CONFLICT' as const }
    if (
      input.snapshot.records.length < config.validation.minRecords ||
      input.snapshot.records.length > config.validation.maxRecords
    )
      return { status: 'CONFLICT' as const }
    const previous = await tx.liveDataObservation.findFirst({
      where: { connectorId: input.connectorId, tenantId: input.tenantId, venueId: input.venueId },
      select: { values: true },
    })
    const prior = SourceConnectionSnapshotSchema.safeParse(previous?.values)
    const old =
      prior.success && sourceConnectionSnapshotHash(prior.data.records) === prior.data.contentHash
        ? prior.data
        : null
    const receipt = readSourceConnectionPreview(connector.lastTestPreview)
    const exactApprovedPreview =
      receipt?.previewHash === config.approval.approvedPreviewHash &&
      receipt.contentHash === input.snapshot.contentHash &&
      receipt.configHash === hash &&
      receipt.status === 'VALID' &&
      receipt.issues.length === 0 &&
      sourceConnectionSnapshotHash(receipt.records) === input.snapshot.contentHash
    if (!old || old.configHash !== hash) {
      if (!exactApprovedPreview) return { status: 'CONFLICT' as const }
    } else if (old.contentHash !== input.snapshot.contentHash && !exactApprovedPreview) {
      if (config.publicationPolicy !== 'auto_verified') return { status: 'CONFLICT' as const }
      const previousById = new Map(
        old.records.map((record) => [record.id, sourceConnectionSnapshotHash(record)]),
      )
      const nextById = new Map(
        input.snapshot.records.map((record) => [record.id, sourceConnectionSnapshotHash(record)]),
      )
      const ids = new Set([...previousById.keys(), ...nextById.keys()])
      const changedCount = [...ids].filter((id) => previousById.get(id) !== nextById.get(id)).length
      if (changedCount / Math.max(1, ids.size) > config.validation.maxChangedFraction)
        return { status: 'CONFLICT' as const }
    }
    const oldById = new Map(old?.records.map((record) => [record.id, record]))
    const oldPublications = new Map(old?.publicationIds.map((item) => [item.recordId, item]))
    const evidenceSourceId = await recordSourceConnectionEvidence(
      {
        ...input,
        sourceUrl: input.snapshot.sourceUrl,
        disposition: 'SUCCEEDED',
        evidence: input.snapshot as unknown as Prisma.InputJsonValue,
        bytes: input.snapshot.cost.bytes,
      },
      tx,
    )
    const publicationIds: SourceConnectionSnapshot['publicationIds'] = []
    let changed = false
    for (const record of input.snapshot.records) {
      const moduleId = stableId(input.connectorId, record.id)
      const former = oldPublications.get(record.id)
      const knowledge = await tx.venueKnowledgeEntry.findFirst({
        where: { tenantId: input.tenantId, venueId: input.venueId, contentModuleId: moduleId },
        select: {
          id: true,
          title: true,
          content: true,
          sourceType: true,
          sourceName: true,
          contentRevisionId: true,
          contentPublicationId: true,
        },
      })
      if (knowledge && knowledge.sourceType !== 'UNIVERSAL_CONTENT') continue
      if (
        knowledge &&
        former &&
        (knowledge.title !== oldById.get(record.id)?.title.slice(0, 200) ||
          knowledge.content !== recordContent(oldById.get(record.id)!))
      ) {
        // The database derives canonical projection fields exclusively from its publication
        // ledger. A human publication wins; never mutate or relabel its projection directly.
        changed = true
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorType: 'SYSTEM',
            actorId: `source-connection:${input.connectorId}`,
            actorRole: 'WORKER',
            action: 'source_connection.manual_override_preserved',
            targetType: 'VenueKnowledgeEntry',
            targetId: knowledge.id,
            afterState: { venueId: input.venueId, publicationId: knowledge.contentPublicationId },
          },
          tx,
        )
        continue
      }
      if (knowledge && !former) continue // Existing module ownership cannot be inferred from mutable labels.
      const currentHead = knowledge
        ? await tx.contentModulePublication.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId, moduleId },
            orderBy: { eventOrder: 'desc' },
            select: { id: true, revisionId: true, action: true, actorId: true },
          })
        : null
      if (
        former &&
        (!knowledge ||
          knowledge.id !== former.knowledgeEntryId ||
          knowledge.contentRevisionId !== former.revisionId ||
          knowledge.contentPublicationId !== former.publicationId ||
          currentHead?.id !== former.publicationId ||
          currentHead.action !== 'PUBLISH' ||
          currentHead.actorId !== `source-connection:${input.connectorId}`)
      )
        continue
      const oldRecord = oldById.get(record.id)
      if (
        former &&
        oldRecord &&
        sourceConnectionSnapshotHash(oldRecord) === sourceConnectionSnapshotHash(record)
      ) {
        publicationIds.push(former)
        continue
      }
      const identity = await tx.contentModuleIdentity.findFirst({
        where: { id: moduleId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true, kind: true },
      })
      if (identity && identity.kind !== 'OPERATIONAL_FACT') continue
      if (identity && !former) continue
      if (!identity)
        await tx.contentModuleIdentity.create({
          data: {
            id: moduleId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            kind: 'OPERATIONAL_FACT',
          },
        })
      const lastRevision = await tx.contentModuleRevision.findFirst({
        where: { tenantId: input.tenantId, venueId: input.venueId, moduleId },
        orderBy: { version: 'desc' },
        select: { version: true, id: true },
      })
      if (former && lastRevision?.id !== former.revisionId) continue // A manual revision wins.
      const version = (lastRevision?.version ?? 0) + 1
      const actorId = `source-connection:${input.connectorId}`
      const revision = await tx.contentModuleRevision.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          moduleId,
          kind: 'OPERATIONAL_FACT',
          version,
          audience: 'PUBLIC',
          effectiveFrom: record.effectiveFrom ? new Date(record.effectiveFrom) : null,
          effectiveUntil: record.effectiveUntil ? new Date(record.effectiveUntil) : null,
          createdBy: actorId,
        },
        select: { id: true },
      })
      await tx.operationalFactContent.create({
        data: {
          revisionId: revision.id,
          tenantId: input.tenantId,
          venueId: input.venueId,
          label: record.title.slice(0, 200),
          value: recordContent(record).slice(0, 5000),
          expiresAt: record.effectiveUntil ? new Date(record.effectiveUntil) : null,
        },
      })
      await tx.contentModuleEvidence.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          revisionId: revision.id,
          moduleKind: 'OPERATIONAL_FACT',
          sourceId: evidenceSourceId,
          locator: record.sourceUrl,
          capturedAt: new Date(input.snapshot.observedAt),
          excerptHash: sourceConnectionSnapshotHash(record),
        },
      })
      const publication = await tx.contentModulePublication.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          moduleId,
          revisionId: revision.id,
          moduleKind: 'OPERATIONAL_FACT',
          action: 'PUBLISH',
          requestId: stableUuid(
            input.connectorId,
            record.id,
            input.snapshot.contentHash,
            String(version),
          ),
          actorId,
        },
        select: { id: true },
      })
      // The existing AFTER INSERT ledger trigger creates/updates the canonical search projection.
      const projection = await tx.venueKnowledgeEntry.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          contentModuleId: moduleId,
          contentRevisionId: revision.id,
          contentPublicationId: publication.id,
          sourceType: 'UNIVERSAL_CONTENT',
        },
        select: { id: true },
      })
      if (!projection)
        throw new Error('Source publication projection was not derived by the ledger.')
      publicationIds.push({
        recordId: record.id,
        moduleId,
        revisionId: revision.id,
        publicationId: publication.id,
        knowledgeEntryId: projection.id,
      })
      changed = true
    }
    if (changed)
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorType: 'SYSTEM',
          actorId: `source-connection:${input.connectorId}`,
          actorRole: 'WORKER',
          action: 'source_connection.published',
          targetType: 'LiveDataConnector',
          targetId: input.connectorId,
          afterState: {
            venueId: input.venueId,
            configHash: hash,
            contentHash: input.snapshot.contentHash,
            publicationCount: publicationIds.length,
          },
          sourceReferences: publicationIds.map((item) => ({
            moduleId: item.moduleId,
            revisionId: item.revisionId,
            publicationId: item.publicationId,
          })),
        },
        tx,
      )
    const snapshot: SourceConnectionSnapshot = { ...input.snapshot, publicationIds }
    const values = snapshot as Prisma.InputJsonValue
    const updated = await tx.liveDataObservation.updateMany({
      where: { connectorId: input.connectorId, tenantId: input.tenantId, venueId: input.venueId },
      data: {
        values,
        observedAt: new Date(snapshot.observedAt),
        fetchedAt: input.now,
        timestampBasis: 'source',
        conflicts: [],
      },
    })
    if (updated.count === 0)
      await tx.liveDataObservation.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          connectorId: input.connectorId,
          values,
          observedAt: new Date(snapshot.observedAt),
          fetchedAt: input.now,
          timestampBasis: 'source',
          conflicts: [],
        },
      })
    await tx.liveDataConnector.updateMany({
      where: {
        id: input.connectorId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        state: 'ACTIVE',
      },
      data: {
        lastSuccessAt: input.now,
        lastErrorAt: null,
        lastErrorCategory: null,
        consecutiveFailures: 0,
      },
    })
    return { status: changed ? ('PUBLISHED' as const) : ('UNCHANGED' as const), snapshot }
  })
}
