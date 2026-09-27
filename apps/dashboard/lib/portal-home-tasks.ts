import type { ClientPortalLifecycleView } from '@pathfinder/contracts/client-portal-lifecycle'

import type { ClientPortalTask } from '../components/DashboardOverview'

export type PortalHomeTaskEvidence = {
  missingInformation: Array<{
    requestId: string
    subject: string
    items: string[]
    additionalItemCount?: number
  }>
  additionalMissingRequest: boolean
  hasSharedInformation: boolean
  latestReport: { id: string; title: string } | null
}

type BuildPortalHomeTasksInput = {
  venueId: string
  lifecycle: Pick<ClientPortalLifecycleView, 'state' | 'clientAction' | 'summary'>
  clientPreview: { state: 'AVAILABLE' | 'SUPERSEDED' | 'UNAVAILABLE'; id: string | null }
  chatUrl: string | null
  evidence: PortalHomeTaskEvidence
}

/**
 * Derives the client's home tasks from server evidence. Torchiko's specific
 * information requests always come first; lifecycle work follows; optional
 * reading comes last. Shared by the portal home and its visual fixtures.
 */
export function buildPortalHomeTasks({
  venueId,
  lifecycle,
  clientPreview,
  chatUrl,
  evidence,
}: BuildPortalHomeTasksInput): ClientPortalTask[] {
  const venue = encodeURIComponent(venueId)
  const tasks: ClientPortalTask[] = evidence.missingInformation.map((request) => ({
    id: `missing-information:${request.requestId}`,
    kind: 'information-request',
    title: request.subject,
    description: 'Torchiko Support is waiting for the details below.',
    href: `/support?venue=${venue}&request=${encodeURIComponent(request.requestId)}`,
    required: true,
    items: request.items,
    ...(request.additionalItemCount ? { additionalItemCount: request.additionalItemCount } : {}),
  }))
  if (evidence.additionalMissingRequest) {
    tasks.push({
      id: 'additional-support-questions',
      kind: 'information-request',
      title: 'More questions are waiting in Support',
      description: 'Open Support to see the rest of the information requests for this venue.',
      href: `/support?venue=${venue}`,
      required: true,
    })
  }
  if (
    lifecycle.state === 'CLIENT_PREVIEW' &&
    clientPreview.state === 'AVAILABLE' &&
    clientPreview.id
  ) {
    tasks.push({
      id: 'review-preview',
      kind: 'preview',
      title: 'Review the visitor experience',
      description: 'See what visitors will experience and send any changes through Support.',
      href: `/venues/${venue}/preview/${encodeURIComponent(clientPreview.id)}`,
      required: true,
    })
  } else if (
    lifecycle.state !== 'CLIENT_PREVIEW' &&
    lifecycle.clientAction === 'OPEN_PREVIEW' &&
    chatUrl
  ) {
    tasks.push({
      id: 'open-visitor-experience',
      kind: 'preview',
      title: 'Open visitor experience',
      description: lifecycle.summary,
      href: chatUrl,
      required: true,
    })
  } else if (lifecycle.state === 'SETUP_REQUESTED' || lifecycle.state === 'COLLECTING') {
    tasks.push({
      id: 'share-information',
      kind: 'share-information',
      title: evidence.hasSharedInformation
        ? 'Share more useful information'
        : 'Share your starting information',
      description: evidence.hasSharedInformation
        ? 'Add another website, staff answer, document, or image when it is ready.'
        : 'Start with a website, staff answer, document, or image. Rough source material is welcome.',
      href: `/venues/${venue}/onboarding`,
      required: true,
    })
  } else if (
    lifecycle.state === 'PROCESSING' ||
    lifecycle.state === 'INTERNAL_REVIEW' ||
    lifecycle.state === 'REVISIONS'
  ) {
    tasks.push({
      id: 'onboarding-progress',
      kind: 'progress',
      title: 'View onboarding progress',
      description:
        'See what Torchiko is working on, what is ready, and whether any focused questions need you.',
      href: `/venues/${venue}/onboarding`,
      required: false,
    })
  }
  if (evidence.latestReport) {
    tasks.push({
      id: `report:${evidence.latestReport.id}`,
      kind: 'report',
      title: evidence.latestReport.title,
      description: 'A published Torchiko report is available to read.',
      href: `/weekly-reports/${encodeURIComponent(evidence.latestReport.id)}?venue=${venue}`,
      required: false,
    })
  }
  return tasks.slice(0, 6)
}
