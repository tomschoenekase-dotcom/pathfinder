import { notFound } from 'next/navigation'

import { VenueChatFixture } from '../../components/VenueChatFixture'
import { appearancePreviewAllowed, parseAppearancePreviewParams } from './preview-params'
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
  }>
}) {
  if (!appearancePreviewAllowed(process.env)) notFound()
  const appearance = parseAppearancePreviewParams(await searchParams)

  return (
    <main className={styles.layout}>
      <div className="border-b border-slate-300 bg-slate-50 px-4 py-3 text-center text-sm text-slate-700">
        Example conversation using the visitor guide renderer. This sample cannot send messages;
        changes remain unsaved until you save them in your venue settings.
      </div>
      <VenueChatFixture
        mode="classic"
        state="idle"
        conversation="long"
        asset="ok"
        motion="reduced"
        voice="none"
        network="online"
        route="none"
        branding="none"
        readOnly
        theme={appearance.theme}
        font={appearance.font}
        accent={appearance.accent}
      />
    </main>
  )
}
