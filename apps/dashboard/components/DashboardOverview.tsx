'use client'

import type { ReactNode } from 'react'

import { HomeGuideLink, type HomeGuideState } from './portal/HomeGuideLink'
import { HomePayment } from './portal/HomePayment'
import { HomeRequests, type HomeRequest } from './portal/HomeRequests'
import { PortalPage, portalInput } from './portal/PortalPrimitives'
import { SendInformation } from './portal/SendInformation'

export type { HomeGuideState } from './portal/HomeGuideLink'
export type { HomeRequest } from './portal/HomeRequests'

type DashboardOverviewProps = {
  venue: { id: string; name: string }
  venues: Array<{ id: string; name: string }>
  guide: HomeGuideState
  requests: HomeRequest[]
  canSendLinksAndNotes: boolean
  payment: { available: boolean; canPay: boolean }
}

/**
 * Home does four jobs and nothing else: share the visitor guide, send Torchiko information,
 * see whether anything is owed, and answer what Torchiko has asked for.
 */
export function DashboardOverview({
  payment,
  canSendLinksAndNotes,
  ...props
}: DashboardOverviewProps) {
  return (
    <DashboardOverviewView
      {...props}
      sendSection={
        <SendInformation venueId={props.venue.id} canSendLinksAndNotes={canSendLinksAndNotes} />
      }
      paymentSection={payment.available ? <HomePayment canPay={payment.canPay} /> : null}
    />
  )
}

export function DashboardOverviewView({
  venue,
  venues,
  guide,
  requests,
  sendSection,
  paymentSection,
}: Omit<DashboardOverviewProps, 'payment' | 'canSendLinksAndNotes'> & {
  sendSection: ReactNode
  paymentSection: ReactNode
}) {
  return (
    <PortalPage
      title={venue.name}
      width="wide"
      aside={
        venues.length > 1 ? (
          <div className="w-full sm:w-60">
            <label htmlFor="portal-venue" className="mb-1 block text-sm font-medium text-tk-soft">
              Venue
            </label>
            <select
              id="portal-venue"
              value={venue.id}
              onChange={(event) => {
                window.location.href = `/?venue=${encodeURIComponent(event.currentTarget.value)}`
              }}
              className={portalInput}
            >
              {venues.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
        ) : null
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-start">
        <div className="lg:col-span-2">
          <HomeGuideLink venueId={venue.id} venueName={venue.name} guide={guide} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {sendSection}
          {paymentSection}
        </div>
        <div className="min-w-0">
          <HomeRequests requests={requests} />
        </div>
      </div>
    </PortalPage>
  )
}
