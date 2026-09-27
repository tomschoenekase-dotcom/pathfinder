export const APP_WEBVIEW_CHROME_VALUE = 'hidden'
export const APP_WEBVIEW_COMPACT_HEADER_VALUE = 'compact'

export type EmbedPresentation = 'embed' | 'embed-inline' | 'webview'
export type EmbedSearchParams = Record<string, string | string[] | undefined>
export type AppHeader = 'full' | 'compact'

export function resolveEmbedPresentation(searchParams: EmbedSearchParams): EmbedPresentation {
  const suppliedParameters = Object.entries(searchParams).filter(([, value]) => value !== undefined)

  if (suppliedParameters.length !== 1) {
    return 'embed'
  }

  const [name, value] = suppliedParameters[0]!
  return name === 'chrome' && value === APP_WEBVIEW_CHROME_VALUE ? 'webview' : 'embed'
}

export function resolveAppHeader(searchParams: EmbedSearchParams): AppHeader {
  const suppliedParameters = Object.entries(searchParams).filter(([, value]) => value !== undefined)
  if (suppliedParameters.length !== 1) return 'full'
  const [name, value] = suppliedParameters[0]!
  return name === 'header' && value === APP_WEBVIEW_COMPACT_HEADER_VALUE ? 'compact' : 'full'
}
