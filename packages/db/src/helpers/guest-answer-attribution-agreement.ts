import { createHash } from 'node:crypto'

import {
  analyzeGuestAnswerAttributionAgreement,
  GuestAnswerAttributionAgreementRecordSchema,
} from '@pathfinder/contracts'
import { canonicalEvaluationJson } from '@pathfinder/contracts/evaluation'

import { db } from '../client'

const calibrationSelect = {
  id: true,
  guestChatTurnId: true,
  answerHash: true,
  evidenceSetHash: true,
  attributionSnapshot: true,
  actorId: true,
  createdAt: true,
} as const

export type GuestAnswerAttributionAgreementClient = Pick<typeof db, 'guestAnswerAttribution'>

export async function readGuestAnswerAttributionAgreement(
  input: { tenantId: string; venueId: string; limit: number },
  client: GuestAnswerAttributionAgreementClient = db,
) {
  if (!Number.isInteger(input.limit) || input.limit < 2 || input.limit > 100) {
    throw new Error('Guest-answer attribution agreement limit must be an integer from 2 to 100')
  }
  const limit = input.limit
  const rows = await client.guestAnswerAttribution.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, actorType: 'HUMAN' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: calibrationSelect,
  })
  const truncated = rows.length > limit
  const validRecords = []
  let invalidRecordCount = 0
  for (const row of rows.slice(0, limit)) {
    const parsed = GuestAnswerAttributionAgreementRecordSchema.safeParse({
      attributionId: row.id,
      guestChatTurnId: row.guestChatTurnId,
      reviewerId: row.actorId,
      answerHash: row.answerHash,
      evidenceSetHash: row.evidenceSetHash,
      createdAt: row.createdAt,
      attribution: row.attributionSnapshot,
    })
    if (parsed.success) validRecords.push(parsed.data)
    else invalidRecordCount += 1
  }
  const report = analyzeGuestAnswerAttributionAgreement(validRecords)
  const reportIdentity = {
    schemaVersion: 'guest-answer-attribution-agreement-report-v1',
    target: 'HUMAN_CLAIM_REVIEW_CALIBRATION',
    limit,
    invalidRecordCount,
    truncated,
    report,
  }
  return {
    target: 'HUMAN_CLAIM_REVIEW_CALIBRATION' as const,
    reportHash: createHash('sha256')
      .update(
        `guest-answer-attribution-agreement-report-v1\n${canonicalEvaluationJson(reportIdentity as never)}`,
        'utf8',
      )
      .digest('hex'),
    invalidRecordCount,
    truncated,
    report,
    interpretation: {
      establishesCorrectness: false as const,
      appliesQualityThreshold: false as const,
      authorizesRelease: false as const,
    },
  }
}
