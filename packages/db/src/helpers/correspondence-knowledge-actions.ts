import type { VerifiedActorContext } from '@pathfinder/contracts/actor'
import type { CompanyKnowledgeType } from '@prisma/client'
import type { InputJsonValue } from '@prisma/client/runtime/library'

import { db } from '../client'
import {
  CompanyKnowledgeActionError,
  createCompanyKnowledgeCandidateAction,
} from './company-knowledge-actions'

const ALLOWED_CORRESPONDENCE_TYPES = new Set<CompanyKnowledgeType>([
  'CLIENT_INSIGHT',
  'SALES_LESSON',
  'OPERATIONAL_LESSON',
  'OPEN_QUESTION',
  'COMMITMENT',
  'OTHER',
])

type CorrespondenceKnowledgeClient = Pick<typeof db, '$transaction' | 'prospectEmailMessage'>

/**
 * Converts an already-processed correspondence observation into a reviewable knowledge candidate.
 * It proves source ownership before creating the candidate and never promotes or copies a full
 * email body automatically.
 */
export async function proposeCorrespondenceKnowledgeAction(
  input: {
    tenantId: string
    emailMessageId: string
    type: CompanyKnowledgeType
    title: string
    summary: string
    body: string
    structuredData?: InputJsonValue
    confidence?: number
    sourceExcerpt?: string
    idempotencyKey: string
    actor: VerifiedActorContext
  },
  client: CorrespondenceKnowledgeClient = db,
) {
  if (!ALLOWED_CORRESPONDENCE_TYPES.has(input.type)) {
    throw new CompanyKnowledgeActionError(
      'FORBIDDEN',
      'Correspondence automation may only propose low-risk relationship or operational knowledge',
    )
  }
  const message = await client.prospectEmailMessage.findFirst({
    where: {
      id: input.emailMessageId,
      organization: {
        customerRelationships: { some: { tenantId: input.tenantId, status: 'ACTIVE' } },
      },
    },
    select: { id: true, organizationId: true, occurredAt: true, subject: true },
  })
  if (!message) {
    throw new CompanyKnowledgeActionError(
      'NOT_FOUND',
      'Correspondence source not found in verified account scope',
    )
  }
  return createCompanyKnowledgeCandidateAction(
    {
      tenantId: input.tenantId,
      organizationId: message.organizationId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      body: input.body,
      ...(input.structuredData ? { structuredData: input.structuredData } : {}),
      accessScope: 'ORGANIZATION',
      authority: 'INFERENCE',
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      effectiveAt: message.occurredAt,
      sourceType: 'EMAIL',
      sourceId: message.id,
      sourceRef: `correspondence:${message.id}`,
      ...(input.sourceExcerpt
        ? { sourceExcerpt: input.sourceExcerpt.replace(/\s+/gu, ' ').trim().slice(0, 500) }
        : {}),
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
    },
    client,
  )
}
