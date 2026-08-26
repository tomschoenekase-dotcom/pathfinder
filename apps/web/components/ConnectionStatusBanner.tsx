import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

import type { NetworkConnectionState } from '../hooks/useNetworkStatus'
import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorUiCopy } from './visitor-ui-copy'

export function ConnectionStatusBanner({
  state,
  language = 'English',
}: {
  state: NetworkConnectionState
  language?: SupportedChatLanguage
}) {
  if (state === 'online') return null

  const offline = state === 'offline'
  const presentation = getChatLanguagePresentation(language)
  const [, , , , , , , , , , , , , , offlineTitle, offlineBody, onlineTitle, onlineBody] =
    getVisitorUiCopy(language).shell

  return (
    <div
      className={`border-b px-4 py-2.5 sm:px-6 ${
        offline
          ? 'border-amber-300 bg-amber-50 text-amber-950'
          : 'border-emerald-300 bg-emerald-50 text-emerald-950'
      }`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      lang={presentation.code}
      dir={presentation.direction}
    >
      <div className="mx-auto max-w-2xl text-sm leading-5">
        <span className="font-semibold">{offline ? offlineTitle : onlineTitle}</span>
        <span className="ml-1">{offline ? offlineBody : onlineBody}</span>
      </div>
    </div>
  )
}
