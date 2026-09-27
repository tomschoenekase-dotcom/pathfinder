import { notFound } from 'next/navigation'

import { AppearancePreviewClient } from './AppearancePreviewClient'
import {
  appearancePreviewAllowed,
  appearancePreviewParentOrigin,
  parseAppearancePreviewParams,
} from './preview-params'
import styles from './preview-layout.module.css'

// The staging guard must run with the deployed service environment, not while
// Next builds the image without its runtime Railway variables.
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Appearance preview | Torchiko',
  robots: { index: false, follow: false },
}

export default async function AppearancePreviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    theme?: string | string[]
    font?: string | string[]
    accent?: string | string[]
    appearance?: string | string[]
    background?: string | string[]
    logo?: string | string[]
    name?: string | string[]
    embed?: string | string[]
  }>
}) {
  if (!appearancePreviewAllowed(process.env)) notFound()
  const params = parseAppearancePreviewParams(await searchParams)
  const initial = {
    theme: params.theme,
    font: params.font,
    accent: params.accent,
    appearance: params.appearance,
    background: params.background ? { kind: 'path' as const, path: params.background } : null,
    logo: params.logo ? { kind: 'path' as const, path: params.logo } : null,
    venueName: params.venueName,
  }

  if (params.embedded) {
    // Framed by the client portal, which labels the preview itself. The sample is a picture of
    // the real renderer, so it takes no input and cannot navigate the frame away.
    return (
      <div className={styles.layout} data-preview-embedded="true" inert>
        <AppearancePreviewClient
          initial={initial}
          parentOrigin={appearancePreviewParentOrigin(process.env)}
          inertFrame
        />
      </div>
    )
  }

  return (
    <div className={styles.layout}>
      <aside
        aria-label="Appearance preview notice"
        className={`${styles.notice} border-b border-slate-300 bg-slate-50 px-4 py-3 text-center text-sm text-slate-700`}
      >
        <span className={styles.fullNotice}>
          Example conversation using the visitor guide renderer. This sample cannot send messages;
          changes remain unsaved until you save them in your venue settings.
        </span>
        <span className={styles.compactNotice}>Preview only · Unsaved · No messages sent</span>
      </aside>
      <AppearancePreviewClient initial={initial} parentOrigin={null} />
    </div>
  )
}
