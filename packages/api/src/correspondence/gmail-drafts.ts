import { assertMailboxScope } from './content-safety'
import { mapGmailApiError, type GmailCredentialLeaseProvider } from './gmail'
import { CorrespondenceProviderError, type ProviderMailboxRef } from './types'

/**
 * Native Gmail draft resources (`users.drafts.list` / `users.drafts.get`).
 *
 * A Gmail draft ID is distinct from the draft's current message ID and thread ID, and Gmail
 * replaces the draft message on every edit. This module is read-only: it never creates, updates
 * or dispatches a provider draft, and it never infers that a local draft was sent. A provider
 * draft that disappeared may have been discarded or dispatched; only a SENT-labelled message that
 * inbound synchronization observes is evidence of the latter.
 */

export type GmailApiDraftRef = Readonly<{
  id: string
  messageId: string
  threadId: string
}>

export type GmailDraftApiClient = Readonly<{
  listDrafts(input: {
    accessToken: string
    mailboxAddress: string
    pageToken?: string
    pageSize: number
  }): Promise<{ drafts: readonly GmailApiDraftRef[]; nextPageToken?: string }>
  /** Throws a NOT_FOUND GmailApiError when the draft resource no longer exists. */
  getDraft(input: {
    accessToken: string
    mailboxAddress: string
    draftId: string
  }): Promise<GmailApiDraftRef & { labelIds: readonly string[] }>
}>

export type ProviderDraftRef = Readonly<{
  providerDraftId: string
  providerMessageId: string
  providerThreadId: string
}>

export type ProviderDraftReader = Readonly<{
  listPage(
    mailbox: ProviderMailboxRef,
    input: { pageToken?: string; pageSize: number },
  ): Promise<{ drafts: readonly ProviderDraftRef[]; nextPageToken: string | null }>
  /** Returns null only when the provider reports that this exact draft resource is gone. */
  get(mailbox: ProviderMailboxRef, providerDraftId: string): Promise<ProviderDraftRef | null>
}>

export function createGmailDraftReader(dependencies: {
  credentials: GmailCredentialLeaseProvider
  client: GmailDraftApiClient
}): ProviderDraftReader {
  const authorized = async <T>(mailbox: ProviderMailboxRef, fn: (token: string) => Promise<T>) => {
    assertMailboxScope('GMAIL', mailbox.provider)
    if (!mailbox.credentialRef) {
      throw new CorrespondenceProviderError('NOT_CONFIGURED', 'Gmail credential is not configured')
    }
    const lease = await dependencies.credentials.lease(mailbox.credentialRef)
    try {
      return await lease.withAccessToken(fn)
    } catch (error) {
      return mapGmailApiError(error)
    }
  }
  const toRef = (draft: GmailApiDraftRef): ProviderDraftRef => ({
    providerDraftId: draft.id,
    providerMessageId: draft.messageId,
    providerThreadId: draft.threadId,
  })
  return {
    async listPage(mailbox, input) {
      const page = await authorized(mailbox, (accessToken) =>
        dependencies.client.listDrafts({
          accessToken,
          mailboxAddress: mailbox.mailboxAddress,
          pageSize: input.pageSize,
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        }),
      )
      return { drafts: page.drafts.map(toRef), nextPageToken: page.nextPageToken ?? null }
    },
    async get(mailbox, providerDraftId) {
      try {
        return toRef(
          await authorized(mailbox, (accessToken) =>
            dependencies.client.getDraft({
              accessToken,
              mailboxAddress: mailbox.mailboxAddress,
              draftId: providerDraftId,
            }),
          ),
        )
      } catch (error) {
        if (error instanceof CorrespondenceProviderError && error.code === 'NOT_FOUND') return null
        throw error
      }
    },
  }
}

export type ProviderDraftReferenceStore = Readonly<{
  /** Local drafts that carry a provider draft reference for this exact provider account. */
  listReferencedDrafts(input: {
    providerAccountId: string
    limit: number
  }): Promise<readonly Readonly<{ localDraftId: string; providerDraftId: string }>[]>
  /**
   * Compare-and-set release of one reference confirmed absent at the provider. Must leave the
   * local draft status untouched and return false when the reference changed concurrently.
   */
  releaseAbsentReference(input: {
    providerAccountId: string
    localDraftId: string
    providerDraftId: string
    observedAt: Date
  }): Promise<boolean>
}>

export type ProviderDraftReconciliationResult = Readonly<{
  /** False when the provider listing exceeded its page budget; no absence was then concluded. */
  complete: boolean
  providerDraftsSeen: number
  referencedLocalDrafts: number
  referencesConfirmedPresent: number
  referencesReleasedAsAbsent: number
  /** Provider drafts with no local reference. They stay unlinked; no reference is guessed. */
  unreferencedProviderDrafts: number
}>

const MAX_DRAFT_PAGES = 5
const DRAFT_PAGE_SIZE = 100
const MAX_REFERENCED_DRAFTS = 500
const MAX_ABSENCE_CONFIRMATIONS = 50

export async function reconcileGmailProviderDrafts(input: {
  mailbox: ProviderMailboxRef
  reader: ProviderDraftReader
  store: ProviderDraftReferenceStore
  now?: () => Date
  maxPages?: number
  pageSize?: number
}): Promise<ProviderDraftReconciliationResult> {
  const now = input.now ?? (() => new Date())
  const maxPages = input.maxPages ?? MAX_DRAFT_PAGES
  const pageSize = input.pageSize ?? DRAFT_PAGE_SIZE
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) {
    throw new Error('Provider draft page budget must be between 1 and 20')
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('Provider draft page size must be between 1 and 100')
  }

  const seen = new Map<string, ProviderDraftRef>()
  let pageToken: string | undefined
  let pages = 0
  do {
    const page = await input.reader.listPage(input.mailbox, {
      pageSize,
      ...(pageToken ? { pageToken } : {}),
    })
    for (const draft of page.drafts) seen.set(draft.providerDraftId, draft)
    pageToken = page.nextPageToken ?? undefined
    pages += 1
  } while (pageToken && pages < maxPages)
  const listingComplete = !pageToken

  const referenced = await input.store.listReferencedDrafts({
    providerAccountId: input.mailbox.providerAccountId,
    limit: MAX_REFERENCED_DRAFTS + 1,
  })
  const bounded = referenced.slice(0, MAX_REFERENCED_DRAFTS)
  const referencedIds = new Set(bounded.map((item) => item.providerDraftId))
  let confirmedPresent = 0
  let released = 0
  let confirmations = 0
  let exhaustedConfirmations = false
  for (const local of bounded) {
    if (seen.has(local.providerDraftId)) {
      confirmedPresent += 1
      continue
    }
    // An incomplete listing proves nothing about a missing ID. Even after a complete listing,
    // the exact draft is re-read so only a provider NOT_FOUND releases the reference.
    if (!listingComplete) continue
    if (confirmations >= MAX_ABSENCE_CONFIRMATIONS) {
      exhaustedConfirmations = true
      continue
    }
    confirmations += 1
    const current = await input.reader.get(input.mailbox, local.providerDraftId)
    if (current) {
      confirmedPresent += 1
      continue
    }
    const didRelease = await input.store.releaseAbsentReference({
      providerAccountId: input.mailbox.providerAccountId,
      localDraftId: local.localDraftId,
      providerDraftId: local.providerDraftId,
      observedAt: now(),
    })
    if (didRelease) released += 1
  }

  return {
    complete:
      listingComplete && !exhaustedConfirmations && referenced.length <= MAX_REFERENCED_DRAFTS,
    providerDraftsSeen: seen.size,
    referencedLocalDrafts: bounded.length,
    referencesConfirmedPresent: confirmedPresent,
    referencesReleasedAsAbsent: released,
    unreferencedProviderDrafts: [...seen.keys()].filter((id) => !referencedIds.has(id)).length,
  }
}
