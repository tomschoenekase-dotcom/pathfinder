export type FounderDecisionContext = {
  attentionReason: string
  consequence: string
  observedAt: Date | null
  deadline: { at: Date; kind: 'DUE' | 'EXPIRES' } | null
  occurrenceCount: number
  founderResponseRequiredToProceed: boolean
}

type EventContext = {
  lastOccurredAt: Date
  occurrenceCount?: number
}

export function eventDecisionContext(event: EventContext, urgent: boolean): FounderDecisionContext {
  return {
    attentionReason: urgent
      ? 'An open action-required event is recorded at critical or error severity.'
      : 'An open event is explicitly marked as requiring action.',
    consequence: urgent
      ? 'The recorded risk remains unresolved until it is reviewed.'
      : 'The recorded follow-up remains open until it is reviewed.',
    observedAt: event.lastOccurredAt,
    deadline: null,
    occurrenceCount: Math.max(1, event.occurrenceCount ?? 1),
    founderResponseRequiredToProceed: false,
  }
}

export function questionDecisionContext(question: {
  createdAt: Date
  dueAt?: Date | null
}): FounderDecisionContext {
  return {
    attentionReason: 'A blocking question is waiting for founder judgment.',
    consequence: 'The linked agent run cannot proceed past this question.',
    observedAt: question.createdAt,
    deadline: question.dueAt ? { at: question.dueAt, kind: 'DUE' } : null,
    occurrenceCount: 1,
    founderResponseRequiredToProceed: true,
  }
}

export function approvalDecisionContext(approval: {
  createdAt: Date
  expiresAt?: Date | null
}): FounderDecisionContext {
  return {
    attentionReason: 'A proposed action is waiting for an explicit human approval decision.',
    consequence: 'The proposed action remains unexecuted until a human decision is recorded.',
    observedAt: approval.createdAt,
    deadline: approval.expiresAt ? { at: approval.expiresAt, kind: 'EXPIRES' } : null,
    occurrenceCount: 1,
    founderResponseRequiredToProceed: true,
  }
}

export function fallbackDecisionContext(input: {
  kind: 'BLOCKED_WORK' | 'CUSTOMER_SUPPORT' | 'CLEAR'
  observedAt?: Date | null
}): FounderDecisionContext {
  const copy = {
    BLOCKED_WORK: {
      reason: 'A run is recorded in a blocked or failed state.',
      consequence: 'The requested operation remains blocked; no automatic recovery is implied.',
    },
    CUSTOMER_SUPPORT: {
      reason: 'An active customer support request is visible in the bounded queue.',
      consequence: 'The customer request remains open in its current state.',
    },
    CLEAR: {
      reason: 'No founder-attention item is visible in the bounded queues.',
      consequence: 'No visible founder-attention item is waiting.',
    },
  }[input.kind]
  return {
    attentionReason: copy.reason,
    consequence: copy.consequence,
    observedAt: input.observedAt ?? null,
    deadline: null,
    occurrenceCount: input.kind === 'CLEAR' ? 0 : 1,
    founderResponseRequiredToProceed: false,
  }
}
