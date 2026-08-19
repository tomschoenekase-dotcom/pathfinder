import type { RemoteOnboardingStageId } from '@pathfinder/contracts/remote-onboarding'

const allowedStages = new Set<RemoteOnboardingStageId>([
  'OVERVIEW',
  'MATERIALS',
  'REVIEW',
  'QUESTIONS',
  'PREVIEW',
  'READINESS',
])

export function onboardingReturnHref(venueId: string, stage: RemoteOnboardingStageId) {
  return `/venues/${encodeURIComponent(venueId)}/onboarding#${stage.toLowerCase()}`
}

export function withOnboardingReturn(
  href: string,
  venueId: string,
  stage: RemoteOnboardingStageId,
) {
  const [pathAndQuery, hash = ''] = href.split('#', 2)
  const separator = pathAndQuery!.includes('?') ? '&' : '?'
  const returnTo = encodeURIComponent(onboardingReturnHref(venueId, stage))
  return `${pathAndQuery}${separator}returnTo=${returnTo}${hash ? `#${hash}` : ''}`
}

export function resolveOnboardingReturn(
  candidate: string | string[] | undefined,
  venueId: string,
  fallbackStage: RemoteOnboardingStageId,
) {
  const value = Array.isArray(candidate) ? candidate[0] : candidate
  if (!value || value.length > 300) return onboardingReturnHref(venueId, fallbackStage)
  const match = /^\/venues\/([^/]+)\/onboarding#([a-z-]+)$/u.exec(value)
  if (!match) return onboardingReturnHref(venueId, fallbackStage)
  let returnedVenueId: string
  try {
    returnedVenueId = decodeURIComponent(match[1]!)
  } catch {
    return onboardingReturnHref(venueId, fallbackStage)
  }
  const stage = match[2]!.toUpperCase() as RemoteOnboardingStageId
  return returnedVenueId === venueId && allowedStages.has(stage)
    ? onboardingReturnHref(venueId, stage)
    : onboardingReturnHref(venueId, fallbackStage)
}
