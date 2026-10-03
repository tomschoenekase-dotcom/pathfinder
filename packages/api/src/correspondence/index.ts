export { createClientReplyLinker, type ClientReplyLinker } from './client-reply-linking'
export { normalizeUntrustedCorrespondenceBody } from './content-safety'
export { createFakeCorrespondenceProvider } from './fake'
export type { FakeCorrespondenceState } from './fake'
export {
  chooseThreadMatch,
  createInboundCorrespondenceService,
  foldDeliveryState,
  type DeliveryState,
  type InboundCorrespondenceStore,
  type InboundQuarantineReason,
  type ProviderReceiptIdentity,
  type ReceiptRecord,
  type ReceiptState,
  type ThreadMatch,
  type ThreadMatchCandidate,
} from './inbound-sync'
export {
  createGmailCorrespondenceProvider,
  GmailApiError,
  type GmailApiClient,
  type GmailApiMessage,
  type GmailAuthorizationLease,
  type GmailCredentialLeaseProvider,
} from './gmail'
export { createGmailApiClient } from './gmail-http-client'
export {
  createGmailDraftReader,
  reconcileGmailProviderDrafts,
  type GmailApiDraftRef,
  type GmailDraftApiClient,
  type ProviderDraftReader,
  type ProviderDraftReconciliationResult,
  type ProviderDraftReferenceStore,
  type ProviderDraftRef,
} from './gmail-drafts'
export { createPrismaProviderDraftReferenceStore } from './prisma-provider-draft-store'
export { createGmailOAuthRuntime, type GmailOAuthConfiguration } from './gmail-oauth'
export {
  parseGmailPushEnvelope,
  verifyGooglePubSubPush,
  type VerifiedGooglePubSubIdentity,
} from './google-pubsub'
export { createPrismaInboundCorrespondenceStore } from './prisma-inbound-store'
export { projectGmailBodyForPersistence, type GmailBodyPersistencePolicy } from './body-retention'
export type { CorrespondenceProvider } from './provider'
export * from './types'
