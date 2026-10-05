'use client'

import { useEffect, useMemo, useState } from 'react'

import { DashboardOverviewView, type HomeGuideState } from '../../../components/DashboardOverview'
import { DashboardShellView } from '../../../components/DashboardShell'
import { OperationalUpdatesList } from '../../../components/OperationalUpdatesList'
import { SupportWorkspace } from '../../../components/SupportWorkspace'
import { AccountWorkspace } from '../../../components/portal/AccountWorkspace'
import { BillingWorkspace } from '../../../components/portal/BillingWorkspace'
import { HomePayment } from '../../../components/portal/HomePayment'
import { LookAndFeelEditor } from '../../../components/portal/LookAndFeelEditor'
import { SendInformation } from '../../../components/portal/SendInformation'
import { buildHomeRequests } from '../../../lib/portal-home-requests'
import { FixtureTRPCClientProvider } from '../../../lib/trpc'
import {
  createPortalFixtureClient,
  FIXTURE_VENUE,
  fixtureSupportRequests,
  readFixtureDesign,
  withoutMessages,
  type FixtureOptions,
} from './fixture-client'

export type FixturePage = 'home' | 'look' | 'help' | 'updates' | 'account' | 'billing'

export type ClientPortalFixtureProps = {
  page: FixturePage
  state: string
  role: 'owner' | 'manager' | 'staff'
  options: FixtureOptions
  webOrigin: string
}

const PATHS: Record<FixturePage, string> = {
  home: '/',
  look: '/look-and-feel',
  help: '/support',
  updates: '/operational-updates',
  account: '/settings',
  billing: '/payment',
}

const LONG_NAME = 'The Greater Maple Hollow Regional Nature Center and Wetland Education Preserve'

function guideFor(state: string, webOrigin: string): HomeGuideState {
  if (state === 'building') return { kind: 'building' }
  if (state === 'paused') return { kind: 'paused' }
  if (state === 'preview') return { kind: 'preview' }
  if (state === 'link-unavailable') return { kind: 'link-unavailable' }
  const slug =
    state === 'long'
      ? 'greater-maple-hollow-regional-nature-center-and-wetland-preserve'
      : 'maple-hollow'
  return { kind: 'published', url: `${webOrigin}/${slug}/chat` }
}

function HomeFixture({ state, role, options, webOrigin }: ClientPortalFixtureProps) {
  const requests = fixtureSupportRequests().map(withoutMessages)
  const lifecycle =
    state === 'building'
      ? { state: 'PROCESSING' as const, clientAction: 'NONE' as const }
      : state === 'paused'
        ? { state: 'PAUSED' as const, clientAction: 'CONTACT_SUPPORT' as const }
        : state === 'preview'
          ? { state: 'CLIENT_PREVIEW' as const, clientAction: 'OPEN_PREVIEW' as const }
          : { state: 'LIVE' as const, clientAction: 'NONE' as const }
  const supportRequests =
    state === 'quiet' || state === 'building'
      ? []
      : state === 'long'
        ? requests.map((request, index) =>
            index === 0
              ? {
                  ...request,
                  subject:
                    'Please confirm the updated winter parking arrangements for the overflow lot beside the Heron Marsh boardwalk trailhead',
                }
              : request,
          )
        : requests
  const homeRequests = buildHomeRequests({
    venueId: FIXTURE_VENUE.id,
    lifecycle,
    clientPreview:
      state === 'preview'
        ? { state: 'AVAILABLE', id: 'fixture-preview' }
        : { state: 'UNAVAILABLE', id: null },
    supportRequests,
  })
  return (
    <DashboardOverviewView
      venue={{ id: FIXTURE_VENUE.id, name: state === 'long' ? LONG_NAME : FIXTURE_VENUE.name }}
      venues={[{ id: FIXTURE_VENUE.id, name: FIXTURE_VENUE.name }]}
      guide={guideFor(state, webOrigin)}
      requests={homeRequests}
      sendSection={
        <SendInformation venueId={FIXTURE_VENUE.id} canSendLinksAndNotes={role !== 'staff'} />
      }
      paymentSection={options.payment === 'none' ? null : <HomePayment canPay={role === 'owner'} />}
    />
  )
}

function LookFixture({ role, webOrigin, state }: ClientPortalFixtureProps) {
  const [stored, setStored] = useState<ReturnType<typeof readFixtureDesign> | undefined>(undefined)
  useEffect(() => setStored(readFixtureDesign()), [])
  if (stored === undefined) return null
  const approvedAssets = [
    {
      derivativeId: '11111111-1111-4111-8111-111111111111',
      assetId: '21111111-1111-4111-8111-111111111111',
      altText: 'Maple leaf logo',
      deliveryPath: '/dev-fixtures/visitor-brand-logo.svg',
      sourceObjectGeneration: '31111111-1111-4111-8111-111111111111',
      sha256: 'a'.repeat(64),
      approvedReviewSequence: 1,
    },
    {
      derivativeId: '12222222-2222-4222-8222-222222222222',
      assetId: '22222222-2222-4222-8222-222222222222',
      altText: 'Lake at dusk',
      deliveryPath: '/dev-fixtures/visitor-brand-banner.svg',
      sourceObjectGeneration: '32222222-2222-4222-8222-222222222222',
      sha256: 'b'.repeat(64),
      approvedReviewSequence: 1,
    },
  ]
  return (
    <LookAndFeelEditor
      venues={[{ id: FIXTURE_VENUE.id, name: FIXTURE_VENUE.name }]}
      venue={{
        ...FIXTURE_VENUE,
        updatedAt: stored?.updatedAt ?? '2026-09-20T12:00:00.000Z',
        chatTheme: 'forest',
        chatAccentColor: null,
        chatFont: 'jakarta',
        chatAppearance: stored?.chatAppearance ?? null,
        chatLogoUrl: null,
        chatBannerUrl: null,
        chatLogoDerivativeId:
          stored?.chatLogoDerivativeId !== undefined
            ? stored.chatLogoDerivativeId
            : state === 'branded'
              ? approvedAssets[0]!.derivativeId
              : null,
        chatBannerDerivativeId:
          stored?.chatBannerDerivativeId !== undefined
            ? stored.chatBannerDerivativeId
            : state === 'branded'
              ? approvedAssets[1]!.derivativeId
              : null,
      }}
      canEdit={role !== 'staff'}
      visibleToVisitors
      places={[
        { id: 'fixture-place-cafe', name: 'Lakeside Café' },
        { id: 'fixture-place-kayaks', name: 'Kayak Rentals' },
      ]}
      approvedAssets={approvedAssets}
      pendingReviews={{
        logo: state === 'logo-in-review' ? { href: '/support?request=fixture' } : null,
        background: null,
      }}
      previewOrigin={state === 'no-preview' ? null : webOrigin}
      mediaOrigin={webOrigin}
    />
  )
}

function HelpFixture({ state }: ClientPortalFixtureProps) {
  const requests = fixtureSupportRequests()
  const empty = state === 'empty'
  const detail = empty ? null : requests[0]!
  return (
    <SupportWorkspace
      venues={[{ id: FIXTURE_VENUE.id, name: FIXTURE_VENUE.name }]}
      activeVenue={{ id: FIXTURE_VENUE.id, name: FIXTURE_VENUE.name }}
      initialRequests={empty ? [] : requests.map(withoutMessages)}
      initialNextCursor={null}
      initialDetail={detail ? { ...detail, nextMessageCursor: null } : null}
      initialEligibleAttachments={[]}
      initialEligibleAttachmentsNextCursor={null}
      {...(state === 'new' ? { initialCreateDraft: { category: 'GENERAL', subject: '' } } : {})}
    />
  )
}

function UpdatesFixture() {
  // Same page frame as the Updates route.
  return (
    <div className="min-h-screen bg-tk-paper px-4 pb-16 pt-6 sm:px-8 sm:pt-10 lg:px-10 lg:pt-12">
      <div className="mx-auto max-w-[64rem]">
        <OperationalUpdatesList
          initialUpdates={
            [
              {
                id: 'fixture-update-1',
                venueId: FIXTURE_VENUE.id,
                placeId: null,
                title: 'Heron Marsh boardwalk closed for repairs',
                body: 'Use the Lakeside Loop instead. The boardwalk reopens October 12.',
                updateType: 'CLOSURE',
                priority: 'HIGH',
                status: 'PUBLISHED',
                isActive: true,
                startsAt: '2026-09-25T12:00:00.000Z',
                expiresAt: '2026-10-12T12:00:00.000Z',
                publishedAt: '2026-09-25T12:00:00.000Z',
                createdAt: '2026-09-25T11:30:00.000Z',
                updatedAt: '2026-09-25T12:00:00.000Z',
                createdBy: 'Dana Whitfield',
                publishedBy: 'Dana Whitfield',
                venue: { id: FIXTURE_VENUE.id, name: FIXTURE_VENUE.name },
                place: null,
              },
              {
                id: 'fixture-update-2',
                venueId: FIXTURE_VENUE.id,
                placeId: null,
                title: 'Owl Prowl night walk',
                body: 'Saturday, October 18 at 7 pm. Meet at the visitor center.',
                updateType: 'EVENT',
                priority: 'NORMAL',
                status: 'DRAFT',
                isActive: true,
                startsAt: '2026-10-11T12:00:00.000Z',
                expiresAt: '2026-10-19T03:00:00.000Z',
                publishedAt: null,
                createdAt: '2026-09-26T10:00:00.000Z',
                updatedAt: '2026-09-26T10:00:00.000Z',
                createdBy: 'Jordan Ellis',
                publishedBy: null,
                venue: { id: FIXTURE_VENUE.id, name: FIXTURE_VENUE.name },
                place: null,
              },
            ] as never
          }
        />
      </div>
    </div>
  )
}

export function ClientPortalFixture(props: ClientPortalFixtureProps) {
  const client = useMemo(() => createPortalFixtureClient(props.options), [props.options])
  return (
    <FixtureTRPCClientProvider client={client}>
      <div
        data-fixture="client-portal"
        data-fixture-page={props.page}
        data-fixture-state={props.state}
      >
        <DashboardShellView
          pathname={PATHS[props.page]}
          selectedVenueId={FIXTURE_VENUE.id}
          orgName={FIXTURE_VENUE.name}
          isPlatformAdmin={false}
          routeKey={`${props.page}:${props.state}`}
          signOutControl={
            <button
              type="button"
              className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm font-medium text-tk-soft"
            >
              Sign out
            </button>
          }
        >
          {props.page === 'home' ? (
            <HomeFixture {...props} />
          ) : props.page === 'look' ? (
            <LookFixture {...props} />
          ) : props.page === 'help' ? (
            <HelpFixture {...props} />
          ) : props.page === 'updates' ? (
            <UpdatesFixture />
          ) : props.page === 'billing' ? (
            <BillingWorkspace enabled={props.options.payment !== 'none'} />
          ) : (
            <AccountWorkspace reportsAvailable />
          )}
        </DashboardShellView>
      </div>
    </FixtureTRPCClientProvider>
  )
}
