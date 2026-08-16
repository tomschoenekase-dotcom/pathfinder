export const CLIENT_PORTAL_LIFECYCLE_VERSION = 1 as const

export const CLIENT_PORTAL_LIFECYCLES = [
  'SETUP_REQUESTED',
  'COLLECTING',
  'PROCESSING',
  'INTERNAL_REVIEW',
  'CLIENT_PREVIEW',
  'REVISIONS',
  'READY',
  'LIVE',
  'PAUSED',
  'OFFBOARDING',
] as const

export type ClientPortalLifecycle = (typeof CLIENT_PORTAL_LIFECYCLES)[number]

export type ClientPortalLifecycleEvidence = {
  isActive: boolean
  publicContentCount: number
  wasLive: boolean
  collectingSourceCount: number
  processingSourceCount: number
  reviewSourceCount: number
  intakeProposalCount: number
  packageCounts: { draft: number; approved: number; applied: number; reverted: number }
  hasActiveOffboarding: boolean
}

export type ClientPortalLifecycleView = {
  version: typeof CLIENT_PORTAL_LIFECYCLE_VERSION
  state: ClientPortalLifecycle
  label: string
  headline: string
  summary: string
  clientAction: 'NONE' | 'CONTINUE_INTAKE' | 'OPEN_PREVIEW' | 'CONTACT_SUPPORT'
  clientActionRequired: boolean
}

const VIEWS: Record<ClientPortalLifecycle, Omit<ClientPortalLifecycleView, 'version' | 'state'>> = {
  SETUP_REQUESTED: {
    label: 'Setup requested',
    headline: 'Let’s start building your Torchico.',
    summary: 'Share the information you already have. The Torchico team will handle the setup.',
    clientAction: 'CONTINUE_INTAKE',
    clientActionRequired: true,
  },
  COLLECTING: {
    label: 'Gathering information',
    headline: 'A little more information will help us continue.',
    summary: 'You can add another source now or return when the remaining information is ready.',
    clientAction: 'CONTINUE_INTAKE',
    clientActionRequired: true,
  },
  PROCESSING: {
    label: 'In progress',
    headline: 'We’re preparing the information you shared.',
    summary: 'There is nothing you need to configure while this work is underway.',
    clientAction: 'NONE',
    clientActionRequired: false,
  },
  INTERNAL_REVIEW: {
    label: 'Torchico review',
    headline: 'Your Torchico is being carefully reviewed.',
    summary: 'We’ll let you know if we need anything or when a visitor preview is ready.',
    clientAction: 'NONE',
    clientActionRequired: false,
  },
  CLIENT_PREVIEW: {
    label: 'Preview ready',
    headline: 'Your Torchico is ready for you to preview.',
    summary: 'See what visitors will experience and send any requested changes through Support.',
    clientAction: 'OPEN_PREVIEW',
    clientActionRequired: true,
  },
  REVISIONS: {
    label: 'Updates in progress',
    headline: 'We’re working through the latest changes.',
    summary:
      'No technical setup is needed. We’ll provide another preview when the update is ready.',
    clientAction: 'NONE',
    clientActionRequired: false,
  },
  READY: {
    label: 'Ready to launch',
    headline: 'Your Torchico is ready for a final look.',
    summary: 'Preview the visitor experience. The Torchico team will coordinate launch timing.',
    clientAction: 'OPEN_PREVIEW',
    clientActionRequired: true,
  },
  LIVE: {
    label: 'Live',
    headline: 'Your visitors can explore with Torchico now.',
    summary:
      'Use this portal for timely visitor updates, tone preferences, and help from our team.',
    clientAction: 'NONE',
    clientActionRequired: false,
  },
  PAUSED: {
    label: 'Paused',
    headline: 'Your Torchico is currently paused.',
    summary:
      'Visitors cannot open it right now. Contact Support if you need help or expected it live.',
    clientAction: 'CONTACT_SUPPORT',
    clientActionRequired: true,
  },
  OFFBOARDING: {
    label: 'Closing service',
    headline: 'Your Torchico service is being closed carefully.',
    summary: 'The Torchico team will keep you informed about access and any requested handoff.',
    clientAction: 'NONE',
    clientActionRequired: false,
  },
}

export function resolveClientPortalLifecycle(
  evidence: ClientPortalLifecycleEvidence,
): ClientPortalLifecycleView {
  let state: ClientPortalLifecycle
  const packages = evidence.packageCounts
  if (evidence.hasActiveOffboarding) state = 'OFFBOARDING'
  else if (!evidence.isActive && evidence.wasLive) state = 'PAUSED'
  else if (packages.reverted > 0 || (packages.draft > 0 && packages.applied > 0))
    state = 'REVISIONS'
  else if (evidence.isActive && evidence.publicContentCount > 0) state = 'LIVE'
  else if (packages.applied > 0 || evidence.publicContentCount > 0) state = 'READY'
  else if (packages.approved > 0) state = 'CLIENT_PREVIEW'
  else if (packages.draft > 0 || evidence.intakeProposalCount > 0 || evidence.reviewSourceCount > 0)
    state = 'INTERNAL_REVIEW'
  else if (evidence.processingSourceCount > 0) state = 'PROCESSING'
  else if (evidence.collectingSourceCount > 0) state = 'COLLECTING'
  else state = 'SETUP_REQUESTED'

  return { version: CLIENT_PORTAL_LIFECYCLE_VERSION, state, ...VIEWS[state] }
}
