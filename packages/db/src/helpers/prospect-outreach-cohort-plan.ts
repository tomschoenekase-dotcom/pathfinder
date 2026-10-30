import { createHash } from 'node:crypto'
import { z } from 'zod'

export const COHORT_ACTOR = 'agent:staging-outreach-cohort-v1'
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const bytesDigest = (value: string) => createHash('sha256').update(value).digest('hex')
export const stableId = (kind: string, value: string) =>
  `stgcohort_${kind}_${digest(value).slice(0, 24)}`
export function operationId(value: string) {
  const h = digest(value)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export function stagingGuard(env: Record<string, string | undefined>) {
  if (
    env.RAILWAY_ENVIRONMENT_ID !== 'a7a394fc-aa4e-4a45-bd3c-904419a67818' ||
    env.DATABASE_RESOURCE_ID !== '7bd81064-588f-48a5-b138-1fc86691a09b' ||
    env.RAILWAY_PROJECT_ID !== '8621111a-4ac8-4d88-9566-4627c8a02059'
  )
    throw new Error('STAGING_IDENTITY_REQUIRED')
}
const message = z
  .object({
    providerMessageId: z.string().min(1),
    providerThreadId: z.string().min(1),
    fromAddress: z.email(),
    toAddresses: z.array(z.email()).min(1),
    subject: z.string(),
    occurredAt: z.iso.datetime(),
    labels: z.array(z.string()),
    classification: z.enum([
      'cold',
      'warm',
      'human',
      'automated',
      'outOfOffice',
      'bounce',
      'policyBlocked',
      'unknown',
    ]),
    internetMessageId: z.string().nullable().optional(),
    inReplyTo: z.string().nullable().optional(),
  })
  .strict()
const target = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('existing'),
      id: z.string().min(1),
      expectedCanonicalName: z.string().min(1),
      verifiedIdentityReceipt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('createObservation'),
      canonicalName: z.string().min(1),
      normalizedDomain: z.string().min(1),
      verifiedRecipient: z.email(),
      sourceProviderMessageId: z.string().min(1),
      verifiedIdentityReceipt: z.string().min(1),
    })
    .strict(),
])
export const cohortPlanSchema = z
  .object({
    schema: z.literal('staging-outreach-cohort/v1'),
    mailboxAddress: z.email(),
    sourceReceiptId: z.string().min(1),
    sourceReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
    cohort: z
      .array(
        z
          .object({
            key: z.string().min(1),
            target,
            globalHistoryComplete: z.literal(false),
            messages: z.array(message).max(30),
            relationship: z.enum(['prospect', 'declined']).optional(),
            bounce: z
              .object({
                recipientAddress: z.email(),
                originalProviderMessageId: z.string().min(1),
                dsnProviderMessageId: z.string().min(1),
              })
              .strict()
              .optional(),
            limitations: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
export type CohortPlan = z.infer<typeof cohortPlanSchema>
export function validatePlan(value: unknown): CohortPlan {
  const plan = cohortPlanSchema.parse(value)
  if (
    plan.cohort.reduce((n, c) => n + c.messages.length, 0) > 30 ||
    new Set(plan.cohort.map((c) => c.key)).size !== plan.cohort.length
  )
    throw new Error('COHORT_BOUND_EXCEEDED_OR_DUPLICATE')
  const seen = new Set<string>()
  for (const cohort of plan.cohort) {
    for (const m of cohort.messages) {
      if (seen.has(m.providerMessageId)) throw new Error('DUPLICATE_PROVIDER_MESSAGE')
      seen.add(m.providerMessageId)
      if (m.labels.includes('DRAFT')) throw new Error('DRAFT_OBSERVATION_FORBIDDEN')
      const outbound = m.fromAddress.toLowerCase() === plan.mailboxAddress.toLowerCase()
      if (
        outbound &&
        (!m.labels.includes('SENT') || !['cold', 'warm', 'unknown'].includes(m.classification))
      )
        throw new Error('OUTBOUND_SENT_CLASSIFICATION_REQUIRED')
      if (
        !outbound &&
        (!m.toAddresses.some((a) => a.toLowerCase() === plan.mailboxAddress.toLowerCase()) ||
          ['cold', 'warm'].includes(m.classification))
      )
        throw new Error('INBOUND_MAILBOX_CLASSIFICATION_MISMATCH')
    }
    if (cohort.target.kind === 'createObservation') {
      const t = cohort.target
      const source = cohort.messages.find((m) => m.providerMessageId === t.sourceProviderMessageId)
      if (
        !source?.labels.includes('SENT') ||
        !source.toAddresses.includes(t.verifiedRecipient) ||
        t.verifiedRecipient.split('@')[1] !== t.normalizedDomain
      )
        throw new Error('NEW_OBSERVATION_IDENTITY_UNBOUND')
    }
    if (cohort.bounce) {
      const b = cohort.bounce
      const original = cohort.messages.find(
        (m) => m.providerMessageId === b.originalProviderMessageId,
      )
      const dsn = cohort.messages.find((m) => m.providerMessageId === b.dsnProviderMessageId)
      if (
        !original?.labels.includes('SENT') ||
        !original.toAddresses.includes(b.recipientAddress) ||
        dsn?.classification !== 'bounce' ||
        original.providerThreadId !== dsn.providerThreadId
      )
        throw new Error('BOUNCE_RECIPIENT_EVIDENCE_UNBOUND')
    }
    if (
      cohort.relationship === 'declined' &&
      !cohort.messages.some((m) => m.classification === 'human')
    )
      throw new Error('DECLINE_REQUIRES_HUMAN_MESSAGE')
  }
  return plan
}
