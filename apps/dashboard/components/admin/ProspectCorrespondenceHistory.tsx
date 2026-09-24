import { ExternalLink, MessageSquareText } from 'lucide-react'

import { safeGmailSourceUrl } from '../../lib/gmail-source-url'
import { ProspectAttachmentRetentionControl } from './ProspectAttachmentRetentionControl'
import { ProspectInboundReplyReviewControl } from './ProspectInboundReplyReviewControl'
import { ProspectReplyContentControl } from './ProspectReplyContentControl'

type Attachment = {
  providerAttachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  downloadPolicy: 'METADATA_ONLY'
}

type RetentionRequest = {
  id: string
  providerAttachmentId: string
  status: 'AWAITING_REVIEW' | 'APPROVED_FOR_IMPORT' | 'DECLINED_SOURCE_ONLY'
  category:
    | 'CONTRACT_OR_ORDER_FORM'
    | 'BROCHURE'
    | 'FLOOR_PLAN_OR_MAP'
    | 'VENUE_OPERATIONS'
    | 'CUSTOMER_KNOWLEDGE'
    | 'GUIDE_MEDIA'
    | 'OTHER_BUSINESS_RECORD'
  purpose: string
  reviewReason: string | null
}

function attachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    if (
      typeof row.providerAttachmentId !== 'string' ||
      typeof row.filename !== 'string' ||
      typeof row.mimeType !== 'string' ||
      typeof row.sizeBytes !== 'number' ||
      row.downloadPolicy !== 'METADATA_ONLY'
    )
      return []
    return [row as Attachment]
  })
}

type ProspectCorrespondenceMessage = {
  id: string
  organizationId?: string
  providerAccount?: { provider: string; mailboxAddress: string } | null
  bodyRetentionState?: string
  bodyExpiresAt?: Date | string | null
  direction: string
  status: string
  fromAddress: string
  toAddresses: string[]
  bodyPreview: string | null
  sourceReference: string | null
  inboundReplyDisposition?:
    | 'POSITIVE_INTEREST'
    | 'QUESTION_OR_OBJECTION'
    | 'NOT_INTERESTED'
    | 'SUPPRESSION_REQUEST'
    | 'OTHER'
    | null
  currentInboundReplyReview?: {
    id: string
    disposition:
      | 'POSITIVE_INTEREST'
      | 'QUESTION_OR_OBJECTION'
      | 'NOT_INTERESTED'
      | 'SUPPRESSION_REQUEST'
      | 'OTHER'
    reason: string
    reviewerId: string
    revision: number
    createdAt: Date | string
  } | null
  onboardingDeliveryAttempts?: Array<{
    id: string
    status: 'DRAFT'
    recipientEmailSnapshot: string
    templateVersion: string
    subject: string
    textBody: string
    createdAt: Date | string
  }>
  attachmentMetadata?: unknown
  attachmentRetentionRequests?: RetentionRequest[]
  occurredAt: Date | string
}

type ProspectCorrespondenceThread = {
  id: string
  subject: string | null
  _count?: { messages: number }
  messages: ProspectCorrespondenceMessage[]
}

export function ProspectCorrespondenceHistory({
  threads,
  totalThreadCount = threads.length,
  enableRetentionActions = false,
  enableReplyReviewActions = false,
}: {
  threads: ProspectCorrespondenceThread[]
  totalThreadCount?: number
  enableRetentionActions?: boolean
  enableReplyReviewActions?: boolean
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <MessageSquareText className="h-5 w-5 text-sky-700" aria-hidden="true" />
        <h2 className="font-semibold text-slate-950">Correspondence history</h2>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Gmail remains the canonical source for complete message content. Torchiko shows a compact
        operational preview and links back to the original when available.
      </p>
      {!threads.length ? (
        <p className="mt-4 text-sm text-slate-500">
          No email correspondence is recorded in this CRM view. Mailbox coverage may be incomplete;
          check the connected account and synchronization state before treating this as no prior
          contact.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {totalThreadCount > threads.length ? (
            <p className="text-sm font-semibold text-amber-900">
              Showing the latest {threads.length} of {totalThreadCount} recorded threads. Older
              correspondence is outside this view.
            </p>
          ) : null}
          {threads.map((thread) => (
            <article key={thread.id} className="rounded-xl border border-slate-200">
              <div className="border-b border-slate-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  {thread.subject ?? 'Email thread'}
                </h3>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                  {thread.messages.length} of {thread._count?.messages ?? thread.messages.length}{' '}
                  recorded message
                  {(thread._count?.messages ?? thread.messages.length) === 1 ? '' : 's'}
                </p>
                {(thread._count?.messages ?? thread.messages.length) > thread.messages.length ? (
                  <p className="mt-1 text-xs font-semibold text-amber-900">
                    Older messages are outside this bounded preview; check the source mailbox for
                    full context.
                  </p>
                ) : null}
              </div>
              <ol className="divide-y divide-slate-100">
                {thread.messages.map((message) => {
                  const sourceUrl = safeGmailSourceUrl(message.sourceReference)
                  const messageAttachments = attachments(message.attachmentMetadata)
                  return (
                    <li key={message.id} className="p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-bold ${message.direction === 'INBOUND' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}
                        >
                          {message.direction} · {message.status}
                        </span>
                        <time className="text-xs text-slate-600">
                          {new Date(message.occurredAt).toLocaleString()}
                        </time>
                      </div>
                      <p className="mt-2 break-words text-xs font-semibold text-slate-700">
                        {message.direction === 'INBOUND'
                          ? message.fromAddress
                          : `To ${message.toAddresses.join(', ')}`}
                      </p>
                      <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">
                        {message.bodyPreview ?? 'No compact preview is available.'}
                      </p>
                      {message.providerAccount?.provider === 'FAKE' ||
                      message.sourceReference?.startsWith('synthetic:') ? (
                        <p className="mt-2 text-sm font-semibold text-amber-900">
                          Synthetic QA correspondence · not evidence of customer contact.
                        </p>
                      ) : null}
                      {message.bodyRetentionState === 'TEMPORARY' ? (
                        <p className="mt-2 text-xs text-slate-700">
                          Temporary reply body{' '}
                          {message.bodyExpiresAt &&
                          new Date(message.bodyExpiresAt).getTime() > Date.now()
                            ? `available until ${new Date(message.bodyExpiresAt).toLocaleString()}`
                            : 'expired; it cannot support a new preparation'}
                          . Full mailbox history may still be incomplete.
                        </p>
                      ) : null}
                      {enableRetentionActions &&
                      message.direction === 'INBOUND' &&
                      message.bodyRetentionState === 'NOT_STORED' &&
                      message.providerAccount?.provider === 'GMAIL' &&
                      message.organizationId ? (
                        <ProspectReplyContentControl
                          key={message.id}
                          messageId={message.id}
                          threadId={thread.id}
                          organizationId={message.organizationId}
                        />
                      ) : null}
                      {sourceUrl ? (
                        <a
                          href={sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-3 inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-sky-800 hover:border-sky-400 hover:bg-sky-50"
                        >
                          <span className="break-words">Open source email in Gmail</span>
                          <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
                        </a>
                      ) : (
                        <p className="mt-3 text-xs text-slate-500">
                          Original source link unavailable.
                        </p>
                      )}
                      {message.direction === 'INBOUND' && enableReplyReviewActions ? (
                        <ProspectInboundReplyReviewControl
                          messageId={message.id}
                          review={message.currentInboundReplyReview ?? null}
                          deliveryAttempt={message.onboardingDeliveryAttempts?.[0] ?? null}
                        />
                      ) : null}
                      {messageAttachments.length ? (
                        <div className="mt-4 border-t border-slate-100 pt-4">
                          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                            Attachments · metadata only
                          </p>
                          <ul className="mt-2 space-y-3">
                            {messageAttachments.map((attachment) => {
                              const request =
                                message.attachmentRetentionRequests?.find(
                                  (item) =>
                                    item.providerAttachmentId === attachment.providerAttachmentId,
                                ) ?? null
                              return (
                                <li
                                  key={attachment.providerAttachmentId}
                                  className="rounded-xl border border-slate-200 p-3"
                                >
                                  <p className="break-words text-sm font-semibold text-slate-900">
                                    {attachment.filename || 'Unnamed attachment'}
                                  </p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    {attachment.mimeType} ·{' '}
                                    {new Intl.NumberFormat('en-US').format(attachment.sizeBytes)}{' '}
                                    bytes · not downloaded
                                  </p>
                                  {enableRetentionActions ? (
                                    <ProspectAttachmentRetentionControl
                                      emailMessageId={message.id}
                                      providerAttachmentId={attachment.providerAttachmentId}
                                      request={request}
                                    />
                                  ) : null}
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
