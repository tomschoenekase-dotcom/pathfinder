import type { NormalizedProviderMessage } from './types'
import { projectReplyText } from './reply-text'

export type GmailBodyPersistencePolicy =
  | Readonly<{ mode: 'SOURCE_ONLY' }>
  | Readonly<{ mode: 'TEMPORARY'; retentionDays: number }>

/**
 * Resolve the worker's explicit retention opt-in. An unset value preserves the
 * source-only boundary; every configured value must be a whole number of days.
 */
export function gmailBodyPersistencePolicyFromEnvironment(
  value: string | undefined,
): GmailBodyPersistencePolicy {
  if (value === undefined || value === '') return { mode: 'SOURCE_ONLY' }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error('Gmail body retention configuration must be an integer from 1 to 30 days')
  }
  const retentionDays = Number(value)
  if (!Number.isSafeInteger(retentionDays) || retentionDays > 30) {
    throw new Error('Gmail body retention configuration must be an integer from 1 to 30 days')
  }
  return { mode: 'TEMPORARY', retentionDays }
}

export function projectGmailBodyForPersistence(input: {
  message: NormalizedProviderMessage
  ingestedAt: Date
  policy?: GmailBodyPersistencePolicy
}) {
  const policy = input.policy ?? { mode: 'SOURCE_ONLY' as const }
  if (
    policy.mode === 'TEMPORARY' &&
    (!Number.isInteger(policy.retentionDays) ||
      policy.retentionDays < 1 ||
      policy.retentionDays > 30)
  ) {
    throw new Error('Temporary Gmail body retention must be between 1 and 30 days')
  }
  const common = {
    bodyPreview:
      projectReplyText(input.message.body.text).text.replace(/\s+/gu, ' ').trim().slice(0, 500) ||
      null,
    sourceReference:
      input.message.message.provider === 'FAKE'
        ? `synthetic:crm-sales:fake-provider:${input.message.message.externalId}`
        : `https://mail.google.com/mail/u/${encodeURIComponent(
            input.message.message.mailboxId,
          )}/#all/${encodeURIComponent(input.message.message.externalId)}`,
  }
  if (policy.mode === 'SOURCE_ONLY') {
    return {
      ...common,
      textBody: null,
      htmlBody: null,
      bodyRetentionState: 'NOT_STORED' as const,
      bodyExpiresAt: null,
    }
  }
  return {
    ...common,
    textBody: input.message.body.text,
    htmlBody: input.message.body.html,
    bodyRetentionState: 'TEMPORARY' as const,
    bodyExpiresAt: new Date(input.ingestedAt.getTime() + policy.retentionDays * 86_400_000),
  }
}
