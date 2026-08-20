import { z } from 'zod'

import { db } from '../client'
import { publishOperationalEvent, type PublishOperationalEventInput } from './operational-events'
import { publishPlatformOperationalEvent } from './platform-operational-events'

const crmSignal = z.enum([
  'import_completed_with_issues',
  'duplicate_conflict',
  'draft_cohort_ready',
  'campaign_awaiting_approval',
  'batch_awaiting_release',
  'outbox_partial_failure',
  'send_operation_stuck',
  'send_permanently_failed',
  'send_ambiguous',
  'provider_authentication_failed',
  'gmail_sync_failed',
  'reply_received',
  'follow_up_due',
  'unsubscribe_received',
  'agent_attention_required',
])

export type CrmOperationalSignal = z.infer<typeof crmSignal>

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform') }).strict(),
  z
    .object({
      kind: z.literal('tenant'),
      tenantId: z.string().min(1).max(191),
      venueId: z.string().min(1).max(191).optional(),
    })
    .strict(),
])

const inputSchema = z
  .object({
    signal: crmSignal,
    scope: scopeSchema,
    linkedObjectType: z.string().trim().min(1).max(64),
    linkedObjectId: z.string().trim().min(1).max(191),
    summary: z.string().trim().min(1).max(2_000),
    deduplicationDiscriminator: z.string().trim().min(1).max(96).optional(),
  })
  .strict()

export type PublishCrmOperationalSignalInput = z.input<typeof inputSchema>

type SignalPolicy = Pick<
  PublishOperationalEventInput,
  'eventType' | 'severity' | 'title' | 'actionRequired' | 'recommendedAction'
>

const POLICY: Record<CrmOperationalSignal, SignalPolicy> = {
  import_completed_with_issues: {
    eventType: 'crm.import.completed_with_issues',
    severity: 'WARNING',
    title: 'Prospect import completed with issues',
    actionRequired: true,
    recommendedAction: 'Review the bounded import reconciliation and quarantined rows.',
  },
  duplicate_conflict: {
    eventType: 'crm.duplicate.conflict',
    severity: 'WARNING',
    title: 'Prospect duplicate needs review',
    actionRequired: true,
    recommendedAction: 'Review the duplicate evidence; do not merge automatically.',
  },
  draft_cohort_ready: {
    eventType: 'crm.draft.cohort_ready',
    severity: 'INFO',
    title: 'Outreach drafts are ready for review',
    actionRequired: true,
    recommendedAction: 'Inspect each recipient, frozen content, grounding, and escalation flag.',
  },
  campaign_awaiting_approval: {
    eventType: 'crm.campaign.awaiting_approval',
    severity: 'INFO',
    title: 'Prospect campaign awaits approval',
    actionRequired: true,
    recommendedAction: 'Review the exact server-side cohort before approval.',
  },
  batch_awaiting_release: {
    eventType: 'crm.batch.awaiting_release',
    severity: 'WARNING',
    title: 'Approved prospect batch awaits final release',
    actionRequired: true,
    recommendedAction: 'Inspect the immutable recipient and content snapshot before release.',
  },
  outbox_partial_failure: {
    eventType: 'crm.outbox.partial_failure',
    severity: 'ERROR',
    title: 'Prospect outbox partially failed',
    actionRequired: true,
    recommendedAction: 'Keep delivery paused and reconcile each failed operation before redrive.',
  },
  send_operation_stuck: {
    eventType: 'crm.send.stuck',
    severity: 'ERROR',
    title: 'Prospect send operation is stuck',
    actionRequired: true,
    recommendedAction: 'Reconcile the expired lease and provider state before redrive.',
  },
  send_permanently_failed: {
    eventType: 'crm.send.permanently_failed',
    severity: 'ERROR',
    title: 'Prospect send permanently failed',
    actionRequired: true,
    recommendedAction: 'Review the sanitized failure classification and provider health.',
  },
  send_ambiguous: {
    eventType: 'crm.send.ambiguous',
    severity: 'CRITICAL',
    title: 'Prospect send outcome is ambiguous',
    actionRequired: true,
    recommendedAction: 'Do not retry until provider reconciliation or human resolution.',
  },
  provider_authentication_failed: {
    eventType: 'crm.provider.authentication_failed',
    severity: 'CRITICAL',
    title: 'Correspondence provider authentication failed',
    actionRequired: true,
    recommendedAction: 'Keep the mailbox paused and reconnect through the credential workflow.',
  },
  gmail_sync_failed: {
    eventType: 'crm.gmail.sync_failed',
    severity: 'ERROR',
    title: 'Gmail synchronization failed',
    actionRequired: true,
    recommendedAction: 'Review mailbox health and run a bounded reconciliation.',
  },
  reply_received: {
    eventType: 'crm.reply.received',
    severity: 'INFO',
    title: 'Prospect reply received',
    actionRequired: true,
    recommendedAction: 'Review the matched thread and resulting follow-up hold.',
  },
  follow_up_due: {
    eventType: 'crm.follow_up.due',
    severity: 'INFO',
    title: 'Prospect follow-up is due',
    actionRequired: true,
    recommendedAction: 'Review current correspondence before preparing a follow-up.',
  },
  unsubscribe_received: {
    eventType: 'crm.unsubscribe.received',
    severity: 'WARNING',
    title: 'Prospect unsubscribed',
    actionRequired: false,
    recommendedAction: 'Confirm suppression was applied; do not contact or restore automatically.',
  },
  agent_attention_required: {
    eventType: 'crm.agent.attention_required',
    severity: 'WARNING',
    title: 'CRM agent work needs human attention',
    actionRequired: true,
    recommendedAction: 'Review the scoped recommendation or Agent Question.',
  },
}

export type PublishCrmOperationalSignalResult = {
  published: true
  scope: 'platform' | 'tenant'
  event: { id: string; state: string; occurrenceCount: number }
}

/**
 * Publishes CRM attention without inventing a customer tenant. Pre-conversion
 * signals use the platform stream; exactly tenant-linked signals use the
 * existing tenant stream and its delivery policies.
 */
export async function publishCrmOperationalSignal(args: {
  client?: Pick<typeof db, 'operationalEvent' | 'platformOperationalEvent'>
  input: PublishCrmOperationalSignalInput
}): Promise<PublishCrmOperationalSignalResult> {
  const input = inputSchema.parse(args.input)
  const policy = POLICY[input.signal]
  const discriminator = input.deduplicationDiscriminator
    ? `:${input.deduplicationDiscriminator}`
    : ''
  const eventInput = {
    ...policy,
    sourceSubsystem: 'prospect-crm',
    summary: input.summary,
    linkedObjectType: input.linkedObjectType,
    linkedObjectId: input.linkedObjectId,
    deduplicationKey: `crm:${input.signal}:${input.linkedObjectType}:${input.linkedObjectId}${discriminator}`,
  }
  if (input.scope.kind === 'platform') {
    const event = await publishPlatformOperationalEvent({
      ...(args.client ? { client: args.client } : {}),
      event: eventInput,
    })
    return { published: true, scope: 'platform', event }
  }

  const event = await publishOperationalEvent({
    ...(args.client ? { client: args.client } : {}),
    event: {
      tenantId: input.scope.tenantId,
      ...(input.scope.venueId ? { venueId: input.scope.venueId } : {}),
      ...eventInput,
    },
  })
  return { published: true, scope: 'tenant', event }
}
