import type {
  FrozenCorrespondence,
  NormalizedProviderMessage,
  ProviderExternalRef,
  ProviderHealth,
  ProviderMailboxRef,
  ProviderSendResult,
  ProviderSyncPage,
  ProviderWatch,
  SendOperationLookup,
} from './types'

export type CorrespondenceProvider = Readonly<{
  key: ProviderMailboxRef['provider']
  capabilities: ReadonlySet<
    | 'SEND_ONE'
    | 'READ_MESSAGE'
    | 'READ_THREAD'
    | 'INCREMENTAL_SYNC'
    | 'FULL_RECONCILIATION'
    | 'MAILBOX_WATCH'
    | 'AMBIGUOUS_SEND_LOOKUP'
    | 'HEALTH'
  >
  sendOne(message: FrozenCorrespondence): Promise<ProviderSendResult>
  retrieveMessage(
    mailbox: ProviderMailboxRef,
    message: ProviderExternalRef,
  ): Promise<NormalizedProviderMessage>
  retrieveThread(
    mailbox: ProviderMailboxRef,
    thread: ProviderExternalRef,
  ): Promise<readonly NormalizedProviderMessage[]>
  syncIncremental(input: {
    mailbox: ProviderMailboxRef
    cursor: string
    pageToken?: string
    pageSize: number
  }): Promise<ProviderSyncPage>
  reconcile(input: {
    mailbox: ProviderMailboxRef
    after: Date
    pageToken?: string
    pageSize: number
  }): Promise<ProviderSyncPage>
  startWatch(input: { mailbox: ProviderMailboxRef; topicName: string }): Promise<ProviderWatch>
  renewWatch(input: { mailbox: ProviderMailboxRef; topicName: string }): Promise<ProviderWatch>
  stopWatch(mailbox: ProviderMailboxRef): Promise<void>
  lookupSendOperation(input: {
    mailbox: ProviderMailboxRef
    operationId: string
    rfcMessageId: string
  }): Promise<SendOperationLookup>
  health(mailbox: ProviderMailboxRef): Promise<ProviderHealth>
}>
