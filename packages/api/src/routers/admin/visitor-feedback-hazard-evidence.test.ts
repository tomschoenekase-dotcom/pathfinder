import { describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import {
  adminVisitorFeedbackHazardEvidenceRouter,
  readVisitorFeedbackHazardEvidence,
} from './visitor-feedback-hazard-evidence'

const event = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  eventType: 'visitor-feedback.potential-urgent-hazard',
  linkedObjectType: 'MessageFeedback',
  linkedObjectId: 'feedback_1',
  occurrenceCount: 2,
  lastOccurredAt: new Date('2026-09-07T20:00:00.000Z'),
}

function deps() {
  return {
    readEvent: vi.fn().mockResolvedValue(event),
    readFeedback: vi.fn().mockResolvedValue({
      id: 'feedback_1',
      rating: 'NOT_HELPFUL',
      reason: 'There is broken glass by the east entrance.',
      updatedAt: new Date('2026-09-07T20:01:00.000Z'),
      sessionId: 'session_1',
      message: {
        id: 'message_1',
        role: 'assistant',
        content: 'The east entrance is open.',
        createdAt: new Date('2026-09-07T19:58:00.000Z'),
      },
    }),
    audit: vi.fn().mockResolvedValue(undefined),
  }
}

describe('visitor feedback hazard evidence', () => {
  it('reads only the exact current feedback and linked message after a strict audit', async () => {
    const harness = deps()
    const result = await readVisitorFeedbackHazardEvidence(
      { eventId: event.id },
      'operator_1',
      harness as never,
    )

    expect(harness.readFeedback).toHaveBeenCalledWith({
      id: 'feedback_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })
    expect(harness.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'VISITOR_FEEDBACK_HAZARD_EVIDENCE_READ',
        targetId: event.id,
        afterState: {
          venueId: 'venue_1',
          feedbackId: 'feedback_1',
          feedbackRating: 'NOT_HELPFUL',
          sessionId: 'session_1',
          messageId: 'message_1',
        },
      }),
    )
    expect(result).toMatchObject({
      effect: 'READ_ONLY',
      currentFeedback: {
        rating: 'NOT_HELPFUL',
        reason: 'There is broken glass by the east entrance.',
        linkedMessage: { content: 'The east entrance is open.' },
      },
      boundaries: {
        signalUnverified: true,
        feedbackMutable: true,
        venuePublicationAuthorized: false,
        operationalMutationAuthorized: false,
      },
    })
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain('broken glass')
  })

  it('returns the changed current feedback rather than treating the original hazard report as immutable', async () => {
    const harness = deps()
    harness.readFeedback.mockResolvedValue({
      id: 'feedback_1',
      rating: 'HELPFUL',
      reason: 'The answer is correct.',
      updatedAt: new Date('2026-09-07T20:05:00.000Z'),
      sessionId: 'session_1',
      message: {
        id: 'message_1',
        role: 'assistant',
        content: 'The east entrance is open.',
        createdAt: new Date('2026-09-07T19:58:00.000Z'),
      },
    })

    await expect(
      readVisitorFeedbackHazardEvidence({ eventId: event.id }, 'operator_1', harness as never),
    ).resolves.toMatchObject({
      currentFeedback: { rating: 'HELPFUL', reason: 'The answer is correct.' },
      boundaries: { feedbackMutable: true, currentFeedbackOnly: true },
    })
  })

  it('does not cross a tenant or venue boundary when the linked current feedback is missing', async () => {
    const harness = deps()
    harness.readFeedback.mockResolvedValue(null)

    await expect(
      readVisitorFeedbackHazardEvidence({ eventId: event.id }, 'operator_1', harness as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(harness.readFeedback).toHaveBeenCalledWith({
      id: 'feedback_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })
    expect(harness.audit).not.toHaveBeenCalled()
  })

  it('rejects callers without the existing administrator authority before reading evidence', async () => {
    const testRouter = router({ admin: adminVisitorFeedbackHazardEvidenceRouter })
    const context: TRPCContext = {
      db: {} as TRPCContext['db'],
      headers: new Headers(),
      session: {
        userId: 'user_1',
        activeTenantId: 'tenant_1',
        role: 'OWNER',
        isPlatformAdmin: false,
      },
    }

    await expect(
      testRouter.createCaller(context).admin.visitorFeedbackHazardEvidence({ eventId: event.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
