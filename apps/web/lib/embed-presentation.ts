export const APP_WEBVIEW_CHROME_VALUE = 'hidden'
export const APP_WEBVIEW_COMPACT_HEADER_VALUE = 'compact'
export const APP_WEBVIEW_NO_HEADER_VALUE = 'none'

export type EmbedPresentation = 'embed' | 'embed-inline' | 'webview'
export type EmbedSearchParams = Record<string, string | string[] | undefined>
export type AppHeader = 'full' | 'compact' | 'none'

// Start input and host opt-ins never change which presentation a door renders.
const NON_PRESENTATION_PARAMETERS = new Set(['ask', 'place', 'placeAction'])

function presentationParameters(searchParams: EmbedSearchParams) {
  return Object.entries(searchParams).filter(
    ([name, value]) => value !== undefined && !NON_PRESENTATION_PARAMETERS.has(name),
  )
}

export function resolveEmbedPresentation(searchParams: EmbedSearchParams): EmbedPresentation {
  const suppliedParameters = presentationParameters(searchParams)

  if (suppliedParameters.length !== 1) {
    return 'embed'
  }

  const [name, value] = suppliedParameters[0]!
  return name === 'chrome' && value === APP_WEBVIEW_CHROME_VALUE ? 'webview' : 'embed'
}

export function resolveAppHeader(searchParams: EmbedSearchParams): AppHeader {
  const suppliedParameters = presentationParameters(searchParams)
  if (suppliedParameters.length !== 1) return 'full'
  const [name, value] = suppliedParameters[0]!
  if (name !== 'header') return 'full'
  if (value === APP_WEBVIEW_COMPACT_HEADER_VALUE) return 'compact'
  return value === APP_WEBVIEW_NO_HEADER_VALUE ? 'none' : 'full'
}
