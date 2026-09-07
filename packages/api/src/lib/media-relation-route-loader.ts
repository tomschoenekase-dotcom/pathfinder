import { z } from 'zod'

import { db } from '@pathfinder/db'

import { assessMediaRelationRouteEligibility } from './media-relation-route-eligibility'

export const MEDIA_ROUTE_RECEIPT_BYTES_LIMIT = 4 * 1024 * 1024
export const MEDIA_ROUTE_STATE_BYTES_LIMIT = 16 * 1024 * 1024
export const MEDIA_ROUTE_PROJECT_LIMIT = 100

type Client = Pick<typeof db, '$transaction'>
type RouteConnection = {
  id: string
  fromLocationId: string
  toLocationId: string
  kind: 'WALKWAY' | 'DOOR' | 'STAIRS' | 'ELEVATOR' | 'ESCALATOR' | 'OUTDOOR_PATH' | 'SHUTTLE'
  bidirectional: boolean
  accessible: boolean
  directions: string | null
  isActive: boolean
  mediaApplicationCount: number
}

type ReceiptMeta = {
  connectionId: string
  rowCount: bigint | number
  payloadBytes: bigint | number
}
type ReceiptRow = {
  connectionId: string
  requestHash: string
  actorId: string
  inputSnapshot: unknown
  revisionId: string
  tenantId: string
  venueId: string
  projectId: string
  sourceGeneration: string
}
type ProjectRow = {
  tenantId: string
  venueId: string
  id: string
  sourceObjectGeneration: string | null
  uploadAttemptId: string | null
}
type StateMeta = { totalBytes: bigint | number }
type StateRow = Pick<ReceiptRow, 'tenantId' | 'venueId' | 'projectId'> & {
  currentState: unknown
}

const scopeKey = (value: Pick<ReceiptRow, 'tenantId' | 'venueId' | 'projectId'>) =>
  JSON.stringify([value.tenantId, value.venueId, value.projectId])

/** Filters only media-origin connections whose immutable review still matches current state. */
export async function filterEligibleMediaRouteConnections<T extends RouteConnection>(params: {
  client: Client
  tenantId: string
  venueId: string
  connections: T[]
}): Promise<T[]> {
  const tenantId = z.string().min(1).max(191).parse(params.tenantId)
  const venueId = z.string().min(1).max(191).parse(params.venueId)
  if (params.connections.length > 1000) throw new Error('Route connection input exceeds 1000.')
  const connectionIds = params.connections.map((connection) => connection.id)
  if (!connectionIds.length) return []
  if (params.connections.every((connection) => connection.mediaApplicationCount === 0))
    return params.connections

  return params.client.$transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const meta = await tx.$queryRaw<ReceiptMeta[]>`
        SELECT connection_id AS "connectionId", count(*) AS "rowCount",
          sum(octet_length(input_snapshot::text)) AS "payloadBytes"
        FROM media_relation_applications
        WHERE tenant_id = ${tenantId} AND venue_id = ${venueId}
          AND connection_id = ANY(${connectionIds}::uuid[])
        GROUP BY connection_id
        LIMIT 1001
      `
      const metadata = new Map(meta.map((row) => [row.connectionId, row]))
      const mediaConnections = params.connections.filter(
        (connection) => connection.mediaApplicationCount > 0,
      )
      const validMetaIds = new Set(
        mediaConnections
          .filter((connection) => {
            const row = metadata.get(connection.id)
            return row && Number(row.rowCount) === 1
          })
          .map((connection) => connection.id),
      )
      const totalReceiptBytes = [...validMetaIds].reduce(
        (total, id) => total + Number(metadata.get(id)!.payloadBytes),
        0,
      )
      if (totalReceiptBytes > MEDIA_ROUTE_RECEIPT_BYTES_LIMIT)
        return params.connections.filter((connection) => connection.mediaApplicationCount === 0)

      const receipts = validMetaIds.size
        ? await tx.$queryRaw<ReceiptRow[]>`
            SELECT application.connection_id AS "connectionId", application.request_hash AS "requestHash",
              application.actor_id AS "actorId", application.input_snapshot AS "inputSnapshot",
              revision.id AS "revisionId", revision.tenant_id AS "tenantId", revision.venue_id AS "venueId",
              revision.project_id AS "projectId", revision.source_generation::text AS "sourceGeneration"
            FROM media_relation_applications application
            JOIN media_entity_resolution_revisions revision
              ON revision.id = application.revision_id AND revision.tenant_id = application.tenant_id
                AND revision.venue_id = application.venue_id
            WHERE application.tenant_id = ${tenantId} AND application.venue_id = ${venueId}
              AND application.connection_id = ANY(${[...validMetaIds]}::uuid[])
          `
        : []
      if (!receipts.length)
        return params.connections.filter((connection) => connection.mediaApplicationCount === 0)
      const projectScopes = [
        ...new Map(receipts.map((receipt) => [scopeKey(receipt), receipt])).values(),
      ]
      if (projectScopes.length > MEDIA_ROUTE_PROJECT_LIMIT)
        return params.connections.filter((connection) => connection.mediaApplicationCount === 0)

      const projects = await tx.mediaIngestionProject.findMany({
        where: {
          tenantId,
          venueId,
          OR: projectScopes.map((scope) => ({ id: scope.projectId })),
        },
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          sourceObjectGeneration: true,
          uploadAttemptId: true,
        },
        take: MEDIA_ROUTE_PROJECT_LIMIT + 1,
      })
      const scopesJson = JSON.stringify(
        projects
          .filter((project: ProjectRow) => project.sourceObjectGeneration)
          .map((project: ProjectRow) => ({
            tenantId: project.tenantId,
            venueId: project.venueId,
            projectId: project.id,
            sourceGeneration: project.sourceObjectGeneration,
          })),
      )
      const stateMeta = projectScopes.length
        ? await tx.$queryRaw<StateMeta[]>`
            WITH requested AS (
              SELECT * FROM jsonb_to_recordset(${scopesJson}::jsonb)
                AS scope("tenantId" text, "venueId" text, "projectId" text, "sourceGeneration" text)
            ), latest AS (
              SELECT DISTINCT ON (revision.tenant_id, revision.venue_id, revision.project_id)
                revision.state
              FROM media_entity_resolution_revisions revision JOIN requested scope
                ON revision.tenant_id = scope."tenantId" AND revision.venue_id = scope."venueId"
                  AND revision.project_id = scope."projectId"
                  AND revision.source_generation::text = scope."sourceGeneration"
              ORDER BY revision.tenant_id, revision.venue_id, revision.project_id, revision.revision DESC
            ) SELECT COALESCE(sum(octet_length(state::text)), 0) AS "totalBytes" FROM latest
          `
        : [{ totalBytes: 0 }]
      if (Number(stateMeta[0]?.totalBytes ?? 0) > MEDIA_ROUTE_STATE_BYTES_LIMIT)
        return params.connections.filter((connection) => connection.mediaApplicationCount === 0)
      const states = projectScopes.length
        ? await tx.$queryRaw<StateRow[]>`
            WITH requested AS (
              SELECT * FROM jsonb_to_recordset(${scopesJson}::jsonb)
                AS scope("tenantId" text, "venueId" text, "projectId" text, "sourceGeneration" text)
            ) SELECT DISTINCT ON (revision.tenant_id, revision.venue_id, revision.project_id)
              revision.tenant_id AS "tenantId", revision.venue_id AS "venueId",
              revision.project_id AS "projectId", revision.state AS "currentState"
            FROM media_entity_resolution_revisions revision JOIN requested scope
              ON revision.tenant_id = scope."tenantId" AND revision.venue_id = scope."venueId"
                AND revision.project_id = scope."projectId"
                AND revision.source_generation::text = scope."sourceGeneration"
            ORDER BY revision.tenant_id, revision.venue_id, revision.project_id, revision.revision DESC
          `
        : []
      const projectByScope = new Map(
        projects.map((project: ProjectRow) => [
          JSON.stringify([project.tenantId, project.venueId, project.id]),
          project,
        ]),
      )
      const stateByScope = new Map(states.map((state) => [scopeKey(state), state.currentState]))
      const receiptByConnection = new Map(
        receipts.map((receipt) => [receipt.connectionId, receipt]),
      )

      return params.connections.filter((native) => {
        if (native.mediaApplicationCount === 0) return true
        const receipt = receiptByConnection.get(native.id)
        if (!receipt) return false
        const project = projectByScope.get(scopeKey(receipt))
        const currentState = stateByScope.get(scopeKey(receipt))
        if (!project || !currentState) return false
        return assessMediaRelationRouteEligibility({
          currentProject: {
            tenantId: project.tenantId,
            venueId: project.venueId,
            projectId: project.id,
            sourceGeneration: project.sourceObjectGeneration,
            uploadAttemptId: project.uploadAttemptId,
          },
          receiptRevision: {
            tenantId: receipt.tenantId,
            venueId: receipt.venueId,
            projectId: receipt.projectId,
            sourceGeneration: receipt.sourceGeneration,
          },
          receipt: {
            connectionId: receipt.connectionId,
            requestHash: receipt.requestHash,
            actorId: receipt.actorId,
            inputSnapshot: receipt.inputSnapshot,
          },
          currentState,
          connection: {
            id: native.id,
            tenantId,
            venueId,
            fromLocationId: native.fromLocationId,
            toLocationId: native.toLocationId,
            kind: native.kind,
            bidirectional: native.bidirectional,
            accessible: native.accessible,
            directions: native.directions,
            isActive: native.isActive,
          },
        }).eligible
      })
    },
    { isolationLevel: 'RepeatableRead' },
  )
}
