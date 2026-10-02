import { notFound } from 'next/navigation'

import {
  OperatorAdminView,
  type OperatorTabId,
} from '../../../components/operator/OperatorAdminView'

const allowedTabs: OperatorTabId[] = ['inbox', 'autonomy', 'connections', 'audit']

export default async function OperatorTabsFixture({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  const params = await searchParams
  const raw = Array.isArray(params.tab) ? params.tab[0] : params.tab
  const tab: OperatorTabId = allowedTabs.find((item) => item === raw) ?? 'inbox'
  await new Promise((resolve) => setTimeout(resolve, 900))

  return (
    <main className="mx-auto max-w-5xl p-6">
      <OperatorAdminView tab={tab} inboxCount={null} hrefBase="/dev-fixtures/operator-tabs">
        <section aria-label="Loaded operator tab" className="py-8">
          <p>Loaded {tab} tab</p>
        </section>
      </OperatorAdminView>
    </main>
  )
}
