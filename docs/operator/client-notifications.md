# Client notification intents (packet W04, acceptance A11 and A12)

Approved information requests reach the customer in two places: their portal conversation and,
where a deployment allows it, their verified email. This records what exists, what is switched off,
and the one gap that is deliberately not faked.

## What an approved information request does

`customers.propose_onboarding_questions`, `support.propose_information_request` and
`support.propose_create_request` (with `notifyByEmail`) apply through the existing proposal,
approval and execution machinery. In the same transaction as the canonical support action, apply
records one `ClientNotificationIntent` (table `client_notification_intents`, a tenanted table):

- the request and its revision (`request_version` is the version the posted message produced, so a
  replay after later activity resolves to the same intent), the posted support message, and the
  blocking question ids it asks about;
- the exact recipient: an ACTIVE member of that tenant, and the address the identity provider has
  verified for them (`resolveVerifiedMemberEmail` in `packages/auth`). Nothing is guessed. A
  support information request with no named recipient uses the only eligible person (requester or
  active participant) and is portal only when there are several;
- frozen content (`content_snapshot`) and its SHA-256 `content_hash`, and an idempotency key derived
  from tenant, request, revision, recipient and content hash (unique per tenant).

A group of onboarding questions is one approval and so one intent, anchored on its first
conversation. Each question keeps its own conversation and the email links to each of them.

The portal post is immediate and is the support message the canonical action already wrote. The
email is a separate channel: apply hands the job to `packages/jobs` after commit, and
`apps/workers` sends it through the same Resend provider path the welcome email uses.

## Receipts

`client_notification_receipts` is append-only (database trigger). Statuses: `portal_posted`,
`email_queued`, `email_sent`, `email_failed`, `email_unknown`. `customers.get_blocking_question` and
`support.get_request` return them with a short failure code, never an address or provider text.

| Email state | Meaning                                                                                                       | Resent?                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| queued      | Job handed to the queue under a job id derived from intent and generation                                     | Same job deduplicates                                      |
| sending     | One worker holds the only claim                                                                               | No                                                         |
| sent        | Provider accepted it                                                                                          | Never                                                      |
| failed      | Provider refused it, the switch was off, no verified address, queue unreachable, or the questions were closed | Only by a deliberate requeue, and only for retryable codes |
| unknown     | The provider call was interrupted or an attempt never reported                                                | Never, until a person reconciles it                        |

A requeue (`requeueClientNotificationEmail`) moves a failed email to a new generation and adds one
`email_queued` receipt. It never writes to the portal again. `reconcileClientNotificationEmail`
resolves an unknown outcome as sent or not sent. Both are database helpers audited with the acting
person; there is deliberately no operator tool for them yet.

## Switch

`CLIENT_NOTIFICATION_EMAIL_ENABLED` (packages/config, default `false`) gates the email. While it is
off the portal post still happens, the intent records the email as failed with
`EMAIL_DELIVERY_DISABLED`, and nothing is queued. Enabling it requires `REDIS_URL`,
`RESEND_API_KEY`, `RESEND_FROM_EMAIL` and `DASHBOARD_URL`. The worker checks it again before
sending. Nothing sends in production without setting it explicitly.

## Stopping a stale email

Before sending, the worker re-checks canonical state. An item is dropped when its question is no
longer pending (answered, declined, expired or cancelled), its conversation is no longer open, or
the customer has already replied. When no item is left the email is closed as failed with
`SUPERSEDED`, which cannot be requeued. A recipient who is no longer an active member, or content
that no longer matches its hash, is closed the same way. There is no reminder scheduler, so there
is nothing further to stop.

## Inbound replies: not built

No inbound path links an email reply to a support request, and none was invented.

- Inbound mail today is the prospect CRM's: Gmail sync matches replies to `ProspectEmailThread` by
  RFC message id, `In-Reply-To` and `References`
  (`packages/api/src/correspondence/prisma-inbound-store.ts`), and quarantines ambiguous ones in
  `ProspectInboundQuarantine`. Every thread belongs to a prospect organization; none references a
  support request or a tenant member.
- The raw webhook receipt and quarantine tables carry no authoritative tenant link, which is why the
  operator manual lists them as unavailable.
- Client notification emails carry no `Reply-To`, token or `Message-ID` that could be matched
  later, and no inbound route exists for the Resend sender address.

To close this gap, in order: send each email with a signed per-intent reply token (and store the
provider message id); add an inbound route that resolves the token to a `(tenant, request)` pair
and never accepts a request id from the sender; require the sender to be an active member of that
tenant; write an accepted reply as a CLIENT support message through the canonical append action;
and quarantine anything ambiguous in a new tenant-owned table. Until then, customers answer in the
portal and a reply by email is not linked.
