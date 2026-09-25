import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  db,
  importExistingProspectGmailDraftAction,
  linkExistingProspectGmailDraftAction,
  ProspectOutreachError,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { requireCrmProspectOutreach } from '../../middleware/require-crm-prospect-outreach'
import { adminProcedure } from '../../trpc'
import { prospectActor } from './prospect-crm-common'
import { GmailApiError, parseGmailAddressHeader } from '../../correspondence'

const id = z.string().min(1).max(191)
function mapError(error: unknown): never {
  if (!(error instanceof ProspectOutreachError)) throw error
  const code =
    error.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.code === 'CONFLICT'
        ? 'CONFLICT'
        : 'BAD_REQUEST'
  throw new TRPCError({ code, message: error.message })
}

export const adminProspectCrmOutreachGmailRouter = router({
  importExistingGmailDraft: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          memberId: id,
          providerAccountId: id,
          providerDraftId: id,
          historyReviewConfirmed: z.literal(true),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        if (!ctx.gmailDraftReader)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Authenticated Gmail draft reading is unavailable',
          })
        const account = await db.correspondenceProviderAccount.findUnique({
          where: { id: input.providerAccountId },
        })
        if (
          !account ||
          account.provider !== 'GMAIL' ||
          account.connectionStatus !== 'CONNECTED' ||
          account.mailboxAddress.trim().toLowerCase() !== 'tomschoenekase@torchiko.com' ||
          !account.credentialReferenceId ||
          !account.lastReconciliationAt
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Connected business Gmail and completed mailbox reconciliation are required',
          })
        }
        let read
        try {
          read = await ctx.gmailDraftReader({
            credentialReferenceId: account.credentialReferenceId,
            mailboxAddress: account.mailboxAddress,
            providerDraftId: input.providerDraftId,
          })
        } catch (error) {
          if (error instanceof GmailApiError && error.kind === 'NOT_FOUND')
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Gmail draft was not found' })
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Gmail draft could not be authenticated and read safely',
          })
        }
        const message = read.message
        if (
          read.authenticatedMailboxAddress.trim().toLowerCase() !==
            account.mailboxAddress.trim().toLowerCase() ||
          read.id !== input.providerDraftId ||
          !message.id ||
          !message.labelIds.includes('DRAFT') ||
          message.duplicateCriticalHeaders?.length ||
          message.hasUnexpectedMimeParts ||
          (message.attachments?.length ?? 0) > 0
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'The selected Gmail item is not a plain draft in the connected business mailbox',
          })
        }
        const headers = message.headers
        const from = parseGmailAddressHeader(headers.from)
        const to = parseGmailAddressHeader(headers.to)
        const cc = parseGmailAddressHeader(headers.cc)
        const bcc = parseGmailAddressHeader(headers.bcc)
        if (
          from.length !== 1 ||
          to.length !== 1 ||
          cc.length ||
          bcc.length ||
          !headers.subject?.trim() ||
          !message.textBody?.trim() ||
          from[0]?.email.toLowerCase() !== 'tomschoenekase@torchiko.com'
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Gmail draft must have one business sender, one recipient, a subject, and a plain-text body',
          })
        }
        return importExistingProspectGmailDraftAction({
          memberId: input.memberId,
          providerAccountId: input.providerAccountId,
          providerDraftId: read.id,
          providerMessageId: message.id,
          fromEmail: from[0]!.email,
          toEmail: to[0]!.email,
          subject: headers.subject,
          textBody: message.textBody,
          ...(message.htmlBody ? { htmlBody: message.htmlBody } : {}),
          historyReviewConfirmed: true,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError)
      }),
    ),

  linkExistingGmailDraft: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          outreachDraftId: id,
          providerAccountId: id,
          providerDraftId: id,
          providerMessageId: id,
          expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
          historyReviewConfirmed: z.literal(true),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        linkExistingProspectGmailDraftAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),
})
