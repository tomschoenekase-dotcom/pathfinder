import type { ClientPortalLifecycleView } from '@pathfinder/contracts/client-portal-lifecycle'

import type { HomeRequest } from '../components/portal/HomeRequests'
import { supportStatusLabel } from './support-status'

export type HomeSupportRequest = {
  id: string
  subject: string
  status: string
  missingInformation: string[]
  canReply: boolean
  clientActivityAt: Date | string
  statusChangedAt: Date | string
}

const MAX_TORCHIKO_ITEMS = 3

function shortDate(value: Date | string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(value),
  )
}

function requestedItems(items: string[]) {
  if (!items.length) return null
  const shown = items.slice(0, 2).join(' · ')
  return items.length > 2 ? `${shown} · and ${items.length - 2} more` : shown
}

/**
 * Home's open requests: what the venue owes first (ember), then a few items Torchiko is
 * working on (neutral). Help conversations are the single source; nothing here is invented.
 */
export function buildHomeRequests({
  venueId,
  lifecycle,
  clientPreview,
  supportRequests,
}: {
  venueId: string
  lifecycle: Pick<ClientPortalLifecycleView, 'state' | 'clientAction'>
  clientPreview: { state: 'AVAILABLE' | 'SUPERSEDED' | 'UNAVAILABLE'; id: string | null }
  supportRequests: HomeSupportRequest[]
}): HomeRequest[] {
  const venue = encodeURIComponent(venueId)
  const needsYou: HomeRequest[] = []
  const working: HomeRequest[] = []

  if (
    lifecycle.state === 'CLIENT_PREVIEW' &&
    clientPreview.state === 'AVAILABLE' &&
    clientPreview.id
  ) {
    needsYou.push({
      id: 'lifecycle-preview',
      title: 'Preview your visitor guide',
      detail: 'Try it before visitors do, and tell us anything to change.',
      needsYou: true,
      meta: null,
      href: `/venues/${venue}/preview/${encodeURIComponent(clientPreview.id)}`,
      actionLabel: 'Open preview',
    })
  }
  if (lifecycle.clientAction === 'CONTINUE_INTAKE') {
    needsYou.push({
      id: 'lifecycle-setup',
      title: 'Finish setting up your guide',
      detail: 'A few starting details help us build it.',
      needsYou: true,
      meta: null,
      href: `/venues/${venue}/onboarding`,
      actionLabel: 'Continue setup',
    })
  }
  if (lifecycle.clientAction === 'CONTACT_SUPPORT') {
    needsYou.push({
      id: 'lifecycle-paused',
      title: 'Let us know if visitors should use the guide again',
      detail: null,
      needsYou: true,
      meta: null,
      href: `/support?venue=${venue}`,
      actionLabel: 'Open Help',
    })
  }

  for (const request of supportRequests) {
    if (request.status === 'COMPLETED' || request.status === 'CANCELLED') continue
    const href = `/support?venue=${venue}&request=${encodeURIComponent(request.id)}`
    if (request.status === 'WAITING_FOR_CLIENT' && request.canReply) {
      needsYou.push({
        id: request.id,
        title: request.subject,
        detail: requestedItems(request.missingInformation),
        needsYou: true,
        meta: `Requested ${shortDate(request.statusChangedAt)}`,
        href,
        actionLabel: 'Reply',
      })
    } else {
      working.push({
        id: request.id,
        title: request.subject,
        detail: null,
        needsYou: false,
        meta: `${supportStatusLabel(request.status)} · ${shortDate(request.clientActivityAt)}`,
        href,
        actionLabel: 'View',
      })
    }
  }

  if (
    working.length < MAX_TORCHIKO_ITEMS &&
    (lifecycle.state === 'PROCESSING' || lifecycle.state === 'INTERNAL_REVIEW')
  ) {
    working.push({
      id: 'lifecycle-building',
      title: 'Building your visitor guide',
      detail: null,
      needsYou: false,
      meta: 'Torchiko is working on it',
      href: `/venues/${venue}/onboarding`,
      actionLabel: 'View',
    })
  }

  return [...needsYou, ...working.slice(0, MAX_TORCHIKO_ITEMS)]
}
