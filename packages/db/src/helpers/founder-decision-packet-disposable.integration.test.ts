import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FounderDecisionPacket } from '@pathfinder/contracts/company-brain'

import { db } from '../client'
import { applyFounderDecisionPacketAction } from './founder-decision-packet-actions'

const enabled =
  process.env.RUN_FOUNDER_DECISION_PACKET_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('founder decision packet disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('applies, replays, supersedes, and preserves source/audit history', async () => {
    const actor = {
      type: 'HUMAN' as const,
      actorId: 'founder-packet-integration',
      role: 'PLATFORM_ADMIN',
    }
    const firstPacket = {
      schemaVersion: 'founder-decision-packet.v1' as const,
      packetId: 'founder-direction-integration-v1',
      title: 'Founder direction v1',
      effectiveAt: '2026-08-22T05:00:00.000Z',
      sourceRef: 'vault://founder-direction-v1',
      decisions: [
        {
          key: 'ordinary-engineering-authority',
          title: 'Ordinary engineering authority',
          summary: 'Codex may make reversible local engineering decisions.',
          decision: 'Proceed with reasonable reversible local engineering decisions.',
          rationale: 'Routine technical choices do not require founder judgment.',
          affectedSystems: ['engineering'],
          scope: { productionAuthorized: false },
        },
      ],
    }

    const applied = await applyFounderDecisionPacketAction({ packet: firstPacket, actor })
    expect(applied.results[0]).toMatchObject({ state: 'APPLIED' })
    await expect(
      applyFounderDecisionPacketAction({ packet: firstPacket, actor }),
    ).resolves.toMatchObject({ results: [{ state: 'REPLAYED_CURRENT' }] })

    const secondPacket = {
      ...firstPacket,
      packetId: 'founder-direction-integration-v2',
      title: 'Founder direction v2',
      effectiveAt: '2026-08-23T05:00:00.000Z',
      sourceRef: 'vault://founder-direction-v2',
      decisions: [
        {
          ...firstPacket.decisions[0]!,
          summary: 'Codex has broad reversible local and staging engineering authority.',
          decision: 'Proceed with reasonable reversible local and staging engineering decisions.',
          scope: { productionAuthorized: false, stagingAuthorized: true },
        },
      ],
    }
    const superseding = await applyFounderDecisionPacketAction({ packet: secondPacket, actor })
    expect(superseding.results[0]).toMatchObject({
      state: 'APPLIED',
      supersededKnowledgeItemId: applied.results[0]!.knowledgeItemId,
    })
    await expect(
      applyFounderDecisionPacketAction({ packet: firstPacket, actor }),
    ).resolves.toMatchObject({ results: [{ state: 'REPLAYED_SUPERSEDED' }] })

    const items = await db.companyKnowledgeItem.findMany({
      where: {
        entityLinks: {
          some: {
            entityType: 'FOUNDER_DECISION_KEY',
            entityId: 'ordinary-engineering-authority',
            relationship: 'GOVERNS',
          },
        },
      },
      orderBy: { effectiveAt: 'asc' },
      select: {
        id: true,
        authority: true,
        promotionStatus: true,
        supersededById: true,
        decision: { select: { status: true, supersedesId: true } },
        sources: { select: { sourceId: true, sourceRef: true } },
      },
    })
    expect(items).toEqual([
      expect.objectContaining({
        authority: 'SUPERSEDED',
        promotionStatus: 'SUPERSEDED',
        supersededById: superseding.results[0]!.knowledgeItemId,
        decision: expect.objectContaining({ status: 'SUPERSEDED', supersedesId: null }),
        sources: [{ sourceId: firstPacket.packetId, sourceRef: firstPacket.sourceRef }],
      }),
      expect.objectContaining({
        authority: 'AUTHORITATIVE_CURRENT',
        promotionStatus: 'PROMOTED',
        supersededById: null,
        decision: expect.objectContaining({
          status: 'ACTIVE',
          supersedesId: expect.any(String),
        }),
        sources: [{ sourceId: secondPacket.packetId, sourceRef: secondPacket.sourceRef }],
      }),
    ])
    expect(
      await db.auditLog.count({
        where: {
          actorId: actor.actorId,
          action: 'company-decision.packet-applied',
        },
      }),
    ).toBe(2)
  })

  it('admits the complete checked-in August 22 packet without external effects', async () => {
    const packet = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../../docs/founder-decision-packet-2026-08-22.json'),
        'utf8',
      ),
    ) as FounderDecisionPacket
    const actor = {
      type: 'HUMAN' as const,
      actorId: 'founder-packet-exact-integration',
      role: 'PLATFORM_ADMIN',
    }
    const applied = await applyFounderDecisionPacketAction({ packet, actor })
    expect(applied.results).toHaveLength(22)
    expect(applied.results.every((result) => result.state === 'APPLIED')).toBe(true)
    expect(
      await db.companyKnowledgeItem.count({
        where: {
          createdById: actor.actorId,
          authority: 'AUTHORITATIVE_CURRENT',
          promotionStatus: 'PROMOTED',
          decision: { status: 'ACTIVE' },
        },
      }),
    ).toBe(22)
    expect(
      await db.auditLog.count({
        where: { actorId: actor.actorId, action: 'company-decision.packet-applied' },
      }),
    ).toBe(22)
    await expect(applyFounderDecisionPacketAction({ packet, actor })).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ state: 'REPLAYED_CURRENT' })]),
    })
  })
})
