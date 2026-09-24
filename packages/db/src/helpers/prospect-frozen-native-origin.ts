import { requireSameLaunchAttachments } from './prospect-launch-attachments'
import {
  operationalOrigin,
  validateOperationalNativeOrigin,
  nativeOriginAccountHash,
  type NativeOriginVerifier,
} from './prospect-native-origin'
import { salesHash, ProspectSalesError, type SalesTransaction } from './prospect-sales-snapshot'

/** The frozen send row does not own source truth. Re-enter the original native
 * owners before dispatch; metadata cannot substitute for a current assessment. */
export async function validateFrozenNativeOrigin(
  tx: SalesTransaction,
  item: {
    draft?: Parameters<typeof validateOperationalNativeOrigin>[0] & {
      status: string
      approvedBy: string | null
      approvedAt: Date | null
    }
    headerSnapshot: unknown
    contentHashSnapshot: string
    recipientEmailSnapshot: string
    subjectSnapshot: string
    textBodySnapshot: string
    htmlBodySnapshot: string | null
  },
  account: unknown,
  verify?: NativeOriginVerifier,
) {
  const headers =
    item.headerSnapshot && typeof item.headerSnapshot === 'object'
      ? (item.headerSnapshot as Record<string, unknown>)
      : {}
  requireSameLaunchAttachments(item.draft?.groundingSnapshot, item.headerSnapshot)
  const origin = item.draft ? operationalOrigin(item.draft.groundingSnapshot) : null
  if (!origin && !headers.nativeSalesOrigin && !headers.nativeOriginHash) return null
  if (
    !origin ||
    !item.draft ||
    salesHash(origin) !== headers.nativeOriginHash ||
    salesHash(headers.nativeSalesOrigin) !== salesHash(origin) ||
    item.draft.status !== 'QUEUED' ||
    !item.draft.approvedBy ||
    !item.draft.approvedAt ||
    item.draft.contentHash !== item.contentHashSnapshot ||
    item.draft.toEmail !== item.recipientEmailSnapshot ||
    item.draft.subject !== item.subjectSnapshot ||
    item.draft.textBody !== item.textBodySnapshot ||
    item.draft.htmlBody !== item.htmlBodySnapshot ||
    nativeOriginAccountHash(account) !== origin.accountHash
  )
    throw new ProspectSalesError(
      'CONFLICT',
      'FROZEN_NATIVE_INTENT_CHANGED: exact approval, content, recipient or account no longer matches',
    )
  return validateOperationalNativeOrigin(item.draft, tx, verify)
}
