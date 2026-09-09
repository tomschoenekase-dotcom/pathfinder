export type SupportCreateDraft = {
  category: 'CONTENT_CORRECTION' | 'BRANDING'
  subject: string
}

export function supportCreateDraft(input: {
  intent: string | string[] | undefined
  hasRequestedRequest: boolean
  requestedVenueId: string | undefined
  selectedVenueId: string
}): SupportCreateDraft | null {
  if (input.hasRequestedRequest || Array.isArray(input.intent)) return null

  if (input.intent === 'visitor-insight') {
    return { category: 'CONTENT_CORRECTION', subject: 'Visitor experience review' }
  }

  if (
    input.intent === 'theme-preference' &&
    input.requestedVenueId !== undefined &&
    input.requestedVenueId === input.selectedVenueId
  ) {
    return { category: 'BRANDING', subject: 'Guide appearance preference' }
  }

  return null
}
