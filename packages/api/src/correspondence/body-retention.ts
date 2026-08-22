import type { NormalizedProviderMessage } from './types'

export type GmailBodyPersistencePolicy =
  | Readonly<{ mode: 'SOURCE_ONLY' }>
  | Readonly<{ mode: 'TEMPORARY'; retentionDays: number }>

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
    bodyPreview: input.message.body.text.replace(/\s+/gu, ' ').trim().slice(0, 500) || null,
    sourceReference: `https://mail.google.com/mail/u/${encodeURIComponent(
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
