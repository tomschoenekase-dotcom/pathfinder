import type { DashboardTRPCClient } from '../../../lib/trpc'

/**
 * In-memory stand-in for the tenant API, used only by the development client-portal fixture.
 * It exercises the real portal components end to end in a browser without a database,
 * storage, billing provider or model. Nothing here is a production code path.
 */

export type FixtureOptions = {
  payment: 'paid' | 'due' | 'past-due' | 'loading' | 'error' | 'none'
  uploads: 'ok' | 'fail-once' | 'checking'
  send: 'ok' | 'fail-once'
  save: 'ok' | 'fail'
}

export const FIXTURE_VENUE = {
  id: 'fixture-maple-hollow',
  name: 'Maple Hollow Nature Center',
  slug: 'maple-hollow',
}

const DESIGN_KEY = 'torchiko:fixture:client-portal:design'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function fixtureError(message: string, code = 'INTERNAL_SERVER_ERROR') {
  return Object.assign(new Error(message), { data: { code } })
}

type StoredDesign = {
  chatAppearance?: unknown
  chatLogoDerivativeId?: string | null
  chatBannerDerivativeId?: string | null
  updatedAt: string
}

export function readFixtureDesign(): StoredDesign | null {
  try {
    const raw = window.sessionStorage.getItem(DESIGN_KEY)
    return raw ? (JSON.parse(raw) as StoredDesign) : null
  } catch {
    return null
  }
}

const now = new Date('2026-09-27T15:00:00.000Z')

type FixtureMessage = {
  id: string
  authorKind: string
  authorIsCurrentUser: boolean
  body: string
  createdAt: string
  attachments: Array<{ id: string; filename: string; mediaType: string; byteSize: string }>
}

type FixtureRequest = {
  id: string
  venueId: string
  category: string
  status: string
  subject: string
  missingInformation: string[]
  clientVersion: number
  clientActivityAt: string
  requesterIsCurrentUser: boolean
  participantIsCurrentUser: boolean
  canReply: boolean
  statusChangedAt: string
  createdAt: string
  messages: FixtureMessage[]
}

/** A request summary as the list endpoint returns it: without its messages. */
export function withoutMessages<T extends { messages: unknown }>(request: T): Omit<T, 'messages'> {
  const { messages, ...summary } = request
  void messages
  return summary
}

export function fixtureSupportRequests(): FixtureRequest[] {
  return [
    {
      id: 'fixture-request-fall-hours',
      venueId: FIXTURE_VENUE.id,
      category: 'OPERATIONAL_UPDATE',
      status: 'WAITING_FOR_CLIENT',
      subject: 'Add fall hours',
      missingInformation: [
        'Your fall opening hours',
        'A photo of the new hours sign, if you have one',
      ],
      clientVersion: 2,
      clientActivityAt: '2026-09-24T15:02:00.000Z',
      requesterIsCurrentUser: true,
      participantIsCurrentUser: false,
      canReply: true,
      statusChangedAt: '2026-09-24T15:02:00.000Z',
      createdAt: '2026-09-24T14:14:00.000Z',
      messages: [
        {
          id: 'fixture-message-1',
          authorKind: 'CLIENT',
          authorIsCurrentUser: true,
          body: 'Hi! Our hours change for fall. Can you update the guide?',
          createdAt: '2026-09-24T14:14:00.000Z',
          attachments: [],
        },
        {
          id: 'fixture-message-2',
          authorKind: 'PLATFORM_ADMIN',
          authorIsCurrentUser: false,
          body: 'Happy to. Could you send the new opening hours? A photo of the sign at the entrance works too.',
          createdAt: '2026-09-24T15:02:00.000Z',
          attachments: [],
        },
      ],
    },
    {
      id: 'fixture-request-trail-map',
      venueId: FIXTURE_VENUE.id,
      category: 'CONTENT_CORRECTION',
      status: 'IN_REVIEW',
      subject: 'Update the Lakeside Loop trail map',
      missingInformation: [],
      clientVersion: 3,
      clientActivityAt: '2026-09-22T17:40:00.000Z',
      requesterIsCurrentUser: true,
      participantIsCurrentUser: false,
      canReply: true,
      statusChangedAt: '2026-09-23T13:10:00.000Z',
      createdAt: '2026-09-22T17:40:00.000Z',
      messages: [
        {
          id: 'fixture-message-3',
          authorKind: 'CLIENT',
          authorIsCurrentUser: true,
          body: 'The Lakeside Loop now ends at the new boardwalk. Updated map attached.',
          createdAt: '2026-09-22T17:40:00.000Z',
          attachments: [
            {
              id: 'fixture-attachment-map',
              filename: 'lakeside-loop-map-2026.pdf',
              mediaType: 'application/pdf',
              byteSize: '842113',
            },
          ],
        },
        {
          id: 'fixture-message-4',
          authorKind: 'PLATFORM_ADMIN',
          authorIsCurrentUser: false,
          body: 'Thanks. We’re checking the new route against your trail signs and will update the guide this week.',
          createdAt: '2026-09-23T13:10:00.000Z',
          attachments: [],
        },
      ],
    },
    {
      id: 'fixture-request-entrance',
      venueId: FIXTURE_VENUE.id,
      category: 'ACCESSIBILITY',
      status: 'COMPLETED',
      subject: 'Accessible entrance directions',
      missingInformation: [],
      clientVersion: 4,
      clientActivityAt: '2026-09-10T16:00:00.000Z',
      requesterIsCurrentUser: true,
      participantIsCurrentUser: false,
      canReply: true,
      statusChangedAt: '2026-09-10T16:00:00.000Z',
      createdAt: '2026-09-08T12:00:00.000Z',
      messages: [
        {
          id: 'fixture-message-5',
          authorKind: 'CLIENT',
          authorIsCurrentUser: true,
          body: 'The accessible entrance is by the north parking lot, not the main gate.',
          createdAt: '2026-09-08T12:00:00.000Z',
          attachments: [],
        },
        {
          id: 'fixture-message-6',
          authorKind: 'PLATFORM_ADMIN',
          authorIsCurrentUser: false,
          body: 'Done. The guide now sends visitors to the north lot entrance.',
          createdAt: '2026-09-10T16:00:00.000Z',
          attachments: [],
        },
      ],
    },
  ]
}

function billingOverview(payment: FixtureOptions['payment']) {
  const due = payment === 'due'
  const pastDue = payment === 'past-due'
  const agreement = {
    id: 'fixture-agreement',
    isBase: true,
    internalPlanKey: 'visitor_guide',
    internalPlanVersion: 1,
    status: due ? 'PENDING' : pastDue ? 'PAST_DUE' : 'ACTIVE',
    billingMode: 'STRIPE_SUBSCRIPTION',
    billingInterval: 'MONTH',
    agreedAmountMinor: 24900,
    venuePriceBreakdownComplete: true,
    currency: 'usd',
    cancelAtPeriodEnd: false,
    currentPeriodEndsAt: due ? null : new Date('2026-10-31T12:00:00.000Z'),
    accessEndsAt: null,
    coveredVenues: [
      { venue: { id: FIXTURE_VENUE.id, name: FIXTURE_VENUE.name }, agreedAmountMinor: 24900 },
    ],
  }
  return {
    enabled: true,
    capabilities: { checkout: true, portal: true, cancellation: true },
    catalog: [{ key: 'visitor_guide', version: 1, displayName: 'Visitor guide' }],
    venues: [],
    access: {
      state: pastDue ? 'PAST_DUE' : due ? 'PENDING' : 'ACTIVE',
      reason: pastDue
        ? 'The October 1 payment didn’t go through.'
        : due
          ? 'Your guide starts once the first payment is made.'
          : 'Paid through October 31, 2026.',
    },
    hasStripeCustomer: !due,
    currentCheckoutUrl: due ? '/dev-fixtures/client-portal?page=account&payment=paid' : null,
    addOnCatalog: [],
    account: {
      billingMode: 'STRIPE_SUBSCRIPTION',
      currency: 'usd',
      status: 'ACTIVE',
      paidThroughAt: due
        ? null
        : new Date(pastDue ? '2026-09-30T12:00:00.000Z' : '2026-10-31T12:00:00.000Z'),
      gracePeriodEndsAt: null,
      reconciliationHealth: 'HEALTHY',
      lastReconciledAt: now,
      commercialAgreements: [agreement],
      invoiceProjections: due
        ? []
        : [
            {
              id: 'fixture-invoice-sep',
              invoiceNumber: 'TK-2026-0917',
              status: 'PAID',
              amountDueMinor: 24900,
              currency: 'usd',
              dueAt: new Date('2026-09-01T12:00:00.000Z'),
              paidAt: new Date('2026-09-01T12:00:00.000Z'),
              createdAt: new Date('2026-09-01T12:00:00.000Z'),
              invoiceDocumentUrl: null,
              hostedInvoiceUrl: null,
            },
          ],
      customerRequests: [],
    },
  }
}

export function createPortalFixtureClient(options: FixtureOptions): DashboardTRPCClient {
  const requests = fixtureSupportRequests()
  const uploads = new Map<string, { fileName: string; mimeType: string; byteSize: number }>()
  const operations = new Map<string, unknown>()
  let reserveCalls = 0
  let sendCalls = 0
  let messageCounter = 10
  let assistantPreference = { enabled: true, minimized: false, revision: 0 }

  const attach = (ids: Array<{ intakeUploadId: string }>) =>
    ids.map(({ intakeUploadId }) => {
      const upload = uploads.get(intakeUploadId)
      if (!upload) throw fixtureError('Verified support attachment not found', 'NOT_FOUND')
      return {
        id: `attachment-${intakeUploadId}`,
        filename: upload.fileName,
        mediaType: upload.mimeType,
        byteSize: String(upload.byteSize),
      }
    })

  function appendMessage(input: {
    operationId: string
    requestId: string
    body: string
    attachments: Array<{ intakeUploadId: string }>
  }) {
    const replay = operations.get(input.operationId)
    if (replay) return { ...(replay as object), replayed: true }
    const request = requests.find((candidate) => candidate.id === input.requestId)
    if (!request) throw fixtureError('Request not found', 'NOT_FOUND')
    const message: FixtureMessage = {
      id: `fixture-message-${++messageCounter}`,
      authorKind: 'CLIENT',
      authorIsCurrentUser: true,
      body: input.body,
      createdAt: new Date().toISOString(),
      attachments: attach(input.attachments),
    }
    request.messages.push(message)
    request.clientVersion += 1
    request.status = 'IN_REVIEW'
    request.missingInformation = []
    const result = {
      message,
      clientVersion: request.clientVersion,
      status: request.status,
      missingInformation: [],
      replayed: false,
    }
    operations.set(input.operationId, result)
    return result
  }

  async function maybeFailSend() {
    sendCalls += 1
    await wait(600)
    if (options.send === 'fail-once' && sendCalls === 1)
      throw fixtureError('Fixture: the first send is dropped to exercise retry.')
  }

  const client = {
    clientAssistant: {
      bootstrap: {
        query: async (input: { venueId?: string }) => {
          if (input.venueId && input.venueId !== FIXTURE_VENUE.id) {
            throw fixtureError('Fixture venue not found', 'NOT_FOUND')
          }
          return {
            available: true,
            venues: [{ id: FIXTURE_VENUE.id, name: FIXTURE_VENUE.name }],
            selectedVenueId: FIXTURE_VENUE.id,
            preference: { ...assistantPreference },
            history: [],
          }
        },
      },
      setPreference: {
        mutate: async (input: {
          venueId: string
          enabled: boolean
          minimized: boolean
          expectedRevision: number
        }) => {
          if (input.venueId !== FIXTURE_VENUE.id) {
            throw fixtureError('Fixture venue not found', 'NOT_FOUND')
          }
          if (input.expectedRevision !== assistantPreference.revision) {
            throw fixtureError('Fixture preference changed. Reload and try again.', 'CONFLICT')
          }
          assistantPreference = {
            enabled: input.enabled,
            minimized: input.minimized,
            revision: assistantPreference.revision + 1,
          }
          return { ...assistantPreference }
        },
      },
    },
    intakeUpload: {
      reserve: {
        mutate: async (input: {
          requestId: string
          fileName: string
          mimeType: string
          byteSize: number
        }) => {
          reserveCalls += 1
          await wait(700)
          if (options.uploads === 'fail-once' && reserveCalls === 1)
            throw fixtureError('Fixture: the first upload is dropped to exercise retry.')
          const id = `fixture-upload-${input.requestId.slice(0, 8)}`
          uploads.set(id, {
            fileName: input.fileName,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
          })
          return {
            upload: {
              id,
              status: options.uploads === 'checking' ? 'VERIFYING' : 'AWAITING_REVIEW',
            },
            uploadRequest: null,
            replayed: false,
            nextAction: 'REVIEW_STATUS',
          }
        },
      },
      verify: {
        mutate: async (input: { uploadId: string }) => {
          await wait(400)
          return {
            upload: { id: input.uploadId, status: 'PRECHECK_PASSED' },
            retryable: true,
            nextAction: 'WAIT',
          }
        },
      },
      signMultipartPart: { mutate: async () => Promise.reject(fixtureError('Not used')) },
      completeMultipart: { mutate: async () => Promise.reject(fixtureError('Not used')) },
      cancelMultipart: { mutate: async () => ({}) },
      list: { query: async () => ({ items: [], nextCursor: null }) },
    },
    intake: {
      createProposal: {
        mutate: async (input: { requestId: string }) => {
          await maybeFailSend()
          operations.set(input.requestId, true)
          return { id: `proposal-${input.requestId.slice(0, 8)}` }
        },
      },
    },
    support: {
      listRequests: {
        query: async () => ({
          items: requests.map(withoutMessages),
          nextCursor: null,
        }),
      },
      getRequest: {
        query: async (input: { requestId: string }) => {
          await wait(250)
          const request = requests.find((candidate) => candidate.id === input.requestId)
          if (!request) throw fixtureError('Request not found', 'NOT_FOUND')
          return { ...request, messages: [...request.messages], nextMessageCursor: null }
        },
      },
      listEligibleAttachments: {
        query: async () => ({
          items: [...uploads.entries()].map(([id, upload]) => ({
            intakeUploadId: id,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            byteSize: upload.byteSize,
            createdAt: now,
          })),
          nextCursor: null,
        }),
      },
      addMessage: {
        mutate: async (input: Parameters<typeof appendMessage>[0]) => {
          await maybeFailSend()
          return appendMessage(input)
        },
      },
      respondToInformation: {
        mutate: async (input: Parameters<typeof appendMessage>[0]) => {
          await maybeFailSend()
          return { ...appendMessage(input), onboardingResume: { linked: false, replayed: false } }
        },
      },
      createRequest: {
        mutate: async (input: {
          operationId: string
          category: string
          subject: string
          body: string
          attachments: Array<{ intakeUploadId: string }>
        }) => {
          const replay = operations.get(input.operationId)
          if (replay) return replay
          await wait(500)
          const request: FixtureRequest = {
            id: `fixture-request-${input.operationId.slice(0, 8)}`,
            venueId: FIXTURE_VENUE.id,
            category: input.category,
            status: 'OPEN',
            subject: input.subject,
            missingInformation: [],
            clientVersion: 1,
            clientActivityAt: new Date().toISOString(),
            requesterIsCurrentUser: true,
            participantIsCurrentUser: false,
            canReply: true,
            statusChangedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messages: [
              {
                id: `fixture-message-${++messageCounter}`,
                authorKind: 'CLIENT',
                authorIsCurrentUser: true,
                body: input.body,
                createdAt: new Date().toISOString(),
                attachments: attach(input.attachments),
              },
            ],
          }
          requests.unshift(request)
          const result = {
            request: withoutMessages(request),
            message: request.messages[0],
            replayed: false,
          }
          operations.set(input.operationId, result)
          return result
        },
      },
      listParticipantCandidates: {
        query: async () => ({
          candidates: [
            { userId: 'fixture-user-2', displayLabel: 'Jordan Ellis', activeOnRequest: true },
            { userId: 'fixture-user-3', displayLabel: 'Priya Natarajan', activeOnRequest: false },
          ],
          nextCursor: null,
        }),
      },
    },
    venue: {
      updateChatDesign: {
        mutate: async (input: {
          chatAppearance: unknown
          chatLogoDerivativeId?: string | null
          chatBannerDerivativeId?: string | null
        }) => {
          await wait(600)
          if (options.save === 'fail') throw fixtureError('Fixture: save failure.')
          const previous = readFixtureDesign()
          const stored: StoredDesign = {
            chatAppearance: input.chatAppearance,
            chatLogoDerivativeId:
              input.chatLogoDerivativeId !== undefined
                ? input.chatLogoDerivativeId
                : (previous?.chatLogoDerivativeId ?? null),
            chatBannerDerivativeId:
              input.chatBannerDerivativeId !== undefined
                ? input.chatBannerDerivativeId
                : (previous?.chatBannerDerivativeId ?? null),
            updatedAt: new Date().toISOString(),
          }
          window.sessionStorage.setItem(DESIGN_KEY, JSON.stringify(stored))
          return { updatedAt: new Date(stored.updatedAt), chatAppearance: stored.chatAppearance }
        },
      },
    },
    billing: {
      overview: {
        query: async () => {
          if (payment() === 'loading') return new Promise(() => undefined)
          await wait(300)
          if (payment() === 'error') throw fixtureError('Fixture: billing unavailable.')
          return billingOverview(payment())
        },
      },
      createPortal: {
        mutate: async () => {
          await wait(400)
          return { url: '/dev-fixtures/client-portal?page=account&payment=paid' }
        },
      },
    },
    tenant: {
      getSettings: {
        query: async () => ({
          tenant: {
            id: 'fixture-tenant',
            name: 'Maple Hollow Nature Center',
            slug: 'maple-hollow',
            planTier: 'standard',
            status: 'ACTIVE',
          },
          members: [
            {
              id: 'fixture-member-1',
              role: 'OWNER',
              status: 'ACTIVE',
              joinedAt: new Date('2026-08-12T12:00:00.000Z'),
              user: { id: 'u1', email: 'dana@maplehollow.example', fullName: 'Dana Whitfield' },
            },
            {
              id: 'fixture-member-2',
              role: 'MANAGER',
              status: 'ACTIVE',
              joinedAt: new Date('2026-08-20T12:00:00.000Z'),
              user: { id: 'u2', email: 'jordan@maplehollow.example', fullName: 'Jordan Ellis' },
            },
          ],
          canManageTeam: true,
        }),
      },
      listPendingInvitations: {
        query: async () => [
          { id: 'fixture-invite', emailAddress: 'priya@maplehollow.example', role: 'org:member' },
        ],
      },
      inviteMember: { mutate: async () => wait(500) },
    },
    operationalUpdate: {
      publish: { mutate: async () => wait(400) },
      deactivate: { mutate: async () => wait(400) },
      list: { query: async () => [] },
    },
  }
  function payment() {
    return options.payment
  }
  return client as unknown as DashboardTRPCClient
}
