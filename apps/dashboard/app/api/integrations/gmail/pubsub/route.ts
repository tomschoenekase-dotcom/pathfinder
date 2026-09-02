import { parseGmailPushEnvelope, verifyGooglePubSubPush } from '@pathfinder/api/correspondence'
import { db, publishCrmOperationalSignal, withTenantIsolationBypass } from '@pathfinder/db'
import { enqueueGmailSync } from '@pathfinder/jobs'
import { NextResponse, type NextRequest } from 'next/server'

import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from '../../../../../lib/bounded-json-request'

export async function POST(request: NextRequest) {
  const expectedAudience = process.env.GMAIL_PUBSUB_PUSH_AUDIENCE
  const expectedServiceAccount = process.env.GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT
  if (!expectedAudience || !expectedServiceAccount) {
    return NextResponse.json({ error: 'Push authentication is not configured' }, { status: 503 })
  }
  try {
    await verifyGooglePubSubPush({
      authorization: request.headers.get('authorization'),
      expectedAudience,
      expectedServiceAccount,
    })
  } catch {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  let notification: ReturnType<typeof parseGmailPushEnvelope>
  try {
    notification = parseGmailPushEnvelope(
      await readBoundedJsonRequest(request, { maxBytes: 64 * 1024 }),
    )
  } catch (error) {
    if (error instanceof BoundedJsonRequestError && error.code === 'BODY_TOO_LARGE') {
      return NextResponse.json({ error: 'Notification too large' }, { status: 413 })
    }
    if (error instanceof BoundedJsonRequestError && error.code === 'BODY_TIMEOUT') {
      return NextResponse.json({ error: 'Notification timeout' }, { status: 408 })
    }
    return NextResponse.json({ error: 'Invalid notification' }, { status: 400 })
  }

  const received = await withTenantIsolationBypass(async () => {
    const account = await db.correspondenceProviderAccount.findUnique({
      where: {
        provider_mailboxAddress: { provider: 'GMAIL', mailboxAddress: notification.emailAddress },
      },
      select: { id: true },
    })
    const receipt = await db.prospectEmailWebhookReceipt.upsert({
      where: {
        provider_providerMailboxKey_providerEventId: {
          provider: 'GMAIL',
          providerMailboxKey: notification.emailAddress,
          providerEventId: notification.messageId,
        },
      },
      create: {
        provider: 'GMAIL',
        providerAccountId: account?.id ?? null,
        providerMailboxKey: notification.emailAddress,
        providerEventId: notification.messageId,
        eventType: 'gmail.history.notification',
        payload: {
          historyId: notification.historyId,
          subscription: notification.subscription,
        },
      },
      update: {},
      select: { id: true, providerAccountId: true, status: true },
    })
    return { account, receipt }
  })

  if (!received.account || !received.receipt.providerAccountId) {
    await publishCrmOperationalSignal({
      input: {
        signal: 'gmail_sync_failed',
        scope: { kind: 'platform' },
        linkedObjectType: 'ProspectEmailWebhookReceipt',
        linkedObjectId: received.receipt.id,
        summary: 'An authenticated Gmail notification referenced an unknown mailbox.',
      },
    })
    return new NextResponse(null, { status: 204 })
  }
  if (!['PROCESSED', 'QUARANTINED'].includes(received.receipt.status)) {
    await enqueueGmailSync({
      providerAccountId: received.receipt.providerAccountId,
      trigger: 'PUBSUB_NOTIFICATION',
      receiptId: received.receipt.id,
    })
  }
  return new NextResponse(null, { status: 204 })
}
