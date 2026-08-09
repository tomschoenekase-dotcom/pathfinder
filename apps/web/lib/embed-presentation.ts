export const APP_WEBVIEW_CHROME_VALUE = 'hidden'

export type EmbedPresentation = 'embed' | 'webview'
export type EmbedSearchParams = Record<string, string | string[] | undefined>

export function resolveEmbedPresentation(searchParams: EmbedSearchParams): EmbedPresentation {
  const suppliedParameters = Object.entries(searchParams).filter(([, value]) => value !== undefined)

  if (suppliedParameters.length !== 1) {
    return 'embed'
  }

  const [name, value] = suppliedParameters[0]!
  return name === 'chrome' && value === APP_WEBVIEW_CHROME_VALUE ? 'webview' : 'embed'
}
