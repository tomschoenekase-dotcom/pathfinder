import { createHash } from 'node:crypto'

import {
  FounderDecisionPacket,
  type FounderDecisionPacket as FounderDecisionPacketInput,
} from '@pathfinder/contracts/company-brain'
import { parseVerifiedActorContext, type VerifiedActorContext } from '@pathfinder/contracts/actor'
import type { InputJsonValue } from '@prisma/client/runtime/library'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type FounderDecisionPacketClient = Pick<typeof db, '$transaction'>

export class FounderDecisionPacketActionError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'FounderDecisionPacketActionError'
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    )
  }
  return value
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

function isSerializationConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2034'
  )
}

function requireFounderDecisionActor(input: VerifiedActorContext) {
  const actor = parseVerifiedActorContext(input)
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN') {
    throw new FounderDecisionPacketActionError(
      'FORBIDDEN',
      'Founder decision packets require a human platform administrator.',
    )
  }
  return actor
}

function idempotencyKey(packetId: string, decisionKey: string): string {
  return `founder-decision:${digest([packetId, decisionKey]).slice(0, 48)}`
}

export async function applyFounderDecisionPacketAction(
  input: { packet: FounderDecisionPacketInput; actor: VerifiedActorContext },
  client: FounderDecisionPacketClient = db,
) {
  const actor = requireFounderDecisionActor(input.actor)
  const packet = FounderDecisionPacket.parse(input.packet)
  const effectiveAt = new Date(packet.effectiveAt)

  const apply = () =>
    client.$transaction(
      async (rawTx) => {
        const tx = rawTx as unknown as typeof db
        const results: Array<{
          key: string
          knowledgeItemId: string
          state: 'APPLIED' | 'REPLAYED_CURRENT' | 'REPLAYED_SUPERSEDED'
          supersededKnowledgeItemId: string | null
        }> = []

        for (const rawDecision of packet.decisions) {
          const affectedSystems = Array.from(new Set(rawDecision.affectedSystems)).sort()
          const scope = stableValue(rawDecision.scope) as InputJsonValue
          const normalized = {
            schemaVersion: packet.schemaVersion,
            packetId: packet.packetId,
            packetTitle: packet.title,
            decisionKey: rawDecision.key,
            title: rawDecision.title,
            summary: rawDecision.summary,
            decision: rawDecision.decision,
            rationale: rawDecision.rationale,
            affectedSystems,
            scope,
            effectiveAt: packet.effectiveAt,
            sourceRef: packet.sourceRef,
          }
          const contentHash = digest(normalized)
          const operationKey = idempotencyKey(packet.packetId, rawDecision.key)
          const existing = await tx.companyKnowledgeItem.findUnique({
            where: { idempotencyKey: operationKey },
            select: {
              id: true,
              contentHash: true,
              authority: true,
              promotionStatus: true,
              decision: { select: { status: true } },
            },
          })
          if (existing) {
            if (existing.contentHash !== contentHash) {
              throw new FounderDecisionPacketActionError(
                'CONFLICT',
                `Decision ${rawDecision.key} changed under an existing packet identity.`,
              )
            }
            const current =
              existing.authority === 'AUTHORITATIVE_CURRENT' &&
              existing.promotionStatus === 'PROMOTED' &&
              existing.decision?.status === 'ACTIVE'
            const superseded =
              existing.authority === 'SUPERSEDED' &&
              existing.promotionStatus === 'SUPERSEDED' &&
              existing.decision?.status === 'SUPERSEDED'
            if (!current && !superseded) {
              throw new FounderDecisionPacketActionError(
                'CONFLICT',
                `Decision ${rawDecision.key} has an invalid replay state.`,
              )
            }
            results.push({
              key: rawDecision.key,
              knowledgeItemId: existing.id,
              state: current ? 'REPLAYED_CURRENT' : 'REPLAYED_SUPERSEDED',
              supersededKnowledgeItemId: null,
            })
            continue
          }

          const priorItems = await tx.companyKnowledgeItem.findMany({
            where: {
              type: 'DECISION',
              authority: 'AUTHORITATIVE_CURRENT',
              promotionStatus: 'PROMOTED',
              archivedAt: null,
              entityLinks: {
                some: {
                  entityType: 'FOUNDER_DECISION_KEY',
                  entityId: rawDecision.key,
                  relationship: 'GOVERNS',
                },
              },
            },
            orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            take: 2,
            select: { id: true, effectiveAt: true, decision: { select: { id: true } } },
          })
          if (priorItems.length > 1) {
            throw new FounderDecisionPacketActionError(
              'CONFLICT',
              `Decision ${rawDecision.key} has multiple current records and requires reconciliation.`,
            )
          }
          const prior = priorItems[0] ?? null
          if (prior && !prior.decision) {
            throw new FounderDecisionPacketActionError(
              'CONFLICT',
              `Decision ${rawDecision.key} is missing its decision record.`,
            )
          }
          if (prior && (!prior.effectiveAt || prior.effectiveAt >= effectiveAt)) {
            throw new FounderDecisionPacketActionError(
              'CONFLICT',
              `Decision ${rawDecision.key} is not newer than the current record.`,
            )
          }

          const created = await tx.companyKnowledgeItem.create({
            data: {
              type: 'DECISION',
              title: rawDecision.title,
              summary: rawDecision.summary,
              accessScope: 'RESTRICTED',
              allowedRoles: ['PLATFORM_ADMIN'],
              authority: 'AUTHORITATIVE_CURRENT',
              promotionStatus: 'PROMOTED',
              currentRevision: 1,
              contentHash,
              effectiveAt,
              lastConfirmedAt: new Date(),
              createdByType: 'HUMAN',
              createdById: actor.actorId,
              idempotencyKey: operationKey,
              revisions: {
                create: {
                  revision: 1,
                  body: rawDecision.decision,
                  structuredData: normalized as unknown as InputJsonValue,
                  sourceDigest: digest([rawDecision.decision, normalized]),
                  authoredByType: 'HUMAN',
                  authoredById: actor.actorId,
                },
              },
              sources: {
                create: {
                  sourceType: 'HUMAN_ENTRY',
                  sourceId: packet.packetId,
                  sourceRef: packet.sourceRef,
                  occurredAt: effectiveAt,
                  metadata: {
                    schemaVersion: packet.schemaVersion,
                    packetTitle: packet.title,
                    decisionKey: rawDecision.key,
                  },
                },
              },
              entityLinks: {
                create: {
                  entityType: 'FOUNDER_DECISION_KEY',
                  entityId: rawDecision.key,
                  relationship: 'GOVERNS',
                },
              },
              decision: {
                create: {
                  status: 'ACTIVE',
                  decision: rawDecision.decision,
                  rationale: rawDecision.rationale,
                  scope,
                  affectedSystems,
                  effectiveAt,
                  ...(prior?.decision ? { supersedesId: prior.decision.id } : {}),
                },
              },
            },
            select: { id: true },
          })

          if (prior) {
            await tx.companyKnowledgeItem.update({
              where: { id: prior.id },
              data: {
                authority: 'SUPERSEDED',
                promotionStatus: 'SUPERSEDED',
                supersededAt: new Date(),
                supersededById: created.id,
                decision: { update: { status: 'SUPERSEDED' } },
              },
            })
          }

          await writeAuditLogStrict(
            {
              actor,
              action: 'company-decision.packet-applied',
              targetType: 'CompanyDecision',
              targetId: created.id,
              idempotencyKey: operationKey,
              structuredReason: {
                packetId: packet.packetId,
                decisionKey: rawDecision.key,
                sourceRef: packet.sourceRef,
              },
              sourceReferences: [
                { type: 'HUMAN_ENTRY', id: packet.packetId, ref: packet.sourceRef },
              ],
              ...(prior ? { beforeState: { priorKnowledgeItemId: prior.id } } : {}),
              afterState: {
                authority: 'AUTHORITATIVE_CURRENT',
                promotionStatus: 'PROMOTED',
                decisionStatus: 'ACTIVE',
                contentHash,
              },
            },
            tx,
          )
          results.push({
            key: rawDecision.key,
            knowledgeItemId: created.id,
            state: 'APPLIED',
            supersededKnowledgeItemId: prior?.id ?? null,
          })
        }

        return {
          schemaVersion: 'founder-decision-packet-result.v1' as const,
          packetId: packet.packetId,
          packetHash: digest(packet),
          results,
        }
      },
      { isolationLevel: 'Serializable' },
    )

  try {
    return await apply()
  } catch (error) {
    if (!isSerializationConflict(error)) throw error
    try {
      return await apply()
    } catch (retryError) {
      if (isSerializationConflict(retryError)) {
        throw new FounderDecisionPacketActionError(
          'CONFLICT',
          'Founder decision packet conflicted with another current-truth update.',
        )
      }
      throw retryError
    }
  }
}
