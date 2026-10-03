import { emailLabel } from '../notifications'

export const notificationIntentSelect = {
  id: true,
  supportRequestId: true,
  requestVersion: true,
  recipientUserId: true,
  contentHash: true,
  emailStatus: true,
  emailLastErrorCode: true,
  emailAttemptCount: true,
  questionIds: true,
  createdAt: true,
} as const

type IntentRow = {
  id: string
  supportRequestId: string
  requestVersion: number
  recipientUserId: string
  contentHash: string
  emailStatus: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN' | null
  emailLastErrorCode: string | null
  emailAttemptCount: number
  questionIds: string[]
  createdAt: Date
}

/**
 * One intent as the operator reads it. The portal post exists by construction. The email label
 * distinguishes queued, sent, failed and unknown; the address, the message text and any provider
 * wording stay out, leaving only a short failure code.
 */
export function notificationSummary(row: IntentRow) {
  return {
    intentId: row.id,
    requestId: row.supportRequestId,
    requestVersion: row.requestVersion,
    recipientUserId: row.recipientUserId,
    contentHash: row.contentHash,
    portal: 'portal_posted' as const,
    email: emailLabel(row.emailStatus),
    emailFailureCode:
      row.emailStatus === 'FAILED' || row.emailStatus === 'UNKNOWN' ? row.emailLastErrorCode : null,
    emailAttempts: row.emailAttemptCount,
    questionCount: row.questionIds.length,
    createdAt: row.createdAt.toISOString(),
  }
}
