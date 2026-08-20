import { CorrespondenceProviderError, type UntrustedCorrespondenceBody } from './types'

export const MAX_PROVIDER_TEXT_BYTES = 100_000
export const MAX_PROVIDER_HTML_BYTES = 200_000
export const MAX_PROVIDER_ATTACHMENTS = 50

function boundedUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return { value, truncated: false }
  return { value: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

export function normalizeUntrustedCorrespondenceBody(input: {
  text?: string | null
  html?: string | null
}): UntrustedCorrespondenceBody {
  const text = boundedUtf8(input.text ?? '', MAX_PROVIDER_TEXT_BYTES)
  const html = input.html ? boundedUtf8(input.html, MAX_PROVIDER_HTML_BYTES) : null
  return {
    text: text.value,
    html: html?.value ?? null,
    truncated: text.truncated || Boolean(html?.truncated),
    trust: 'UNTRUSTED_EXTERNAL_CONTENT',
    renderingPolicy: 'TEXT_FIRST_HTML_REQUIRES_SANITIZATION',
    agentPolicy: 'DATA_ONLY_NEVER_INSTRUCTIONS_OR_AUTHORIZATION',
  }
}

export function assertSafeHeader(value: string, label: string, maxLength = 998) {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || /[\r\n\0]/u.test(trimmed)) {
    throw new CorrespondenceProviderError('INVALID_INPUT', `${label} is invalid`)
  }
  return trimmed
}

export function assertMailboxScope(expected: 'GMAIL' | 'FAKE', mailboxProvider: string) {
  if (mailboxProvider !== expected) {
    throw new CorrespondenceProviderError(
      'INVALID_INPUT',
      `Mailbox provider ${mailboxProvider} cannot be used by ${expected}`,
    )
  }
}

export function assertExternalRefScope(
  mailbox: { provider: string; providerAccountId: string; mailboxId: string },
  reference: { provider: string; providerAccountId: string; mailboxId: string },
) {
  if (
    reference.provider !== mailbox.provider ||
    reference.providerAccountId !== mailbox.providerAccountId ||
    reference.mailboxId !== mailbox.mailboxId
  ) {
    throw new CorrespondenceProviderError(
      'INVALID_INPUT',
      'Provider reference is outside the exact mailbox/account scope',
    )
  }
}
