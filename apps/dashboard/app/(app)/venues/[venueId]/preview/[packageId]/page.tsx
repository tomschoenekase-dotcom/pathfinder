export const dynamic = 'force-dynamic'

import { unstable_noStore as noStore } from 'next/cache'
import Link from 'next/link'

import { ClientPackagePreview } from '../../../../../../components/ClientPackagePreview'
import { createDashboardCaller } from '../../../../../../lib/server-caller'
import { resolveOnboardingReturn } from '../../../../../../lib/onboarding-return'

type Props = {
  params: Promise<{ venueId: string; packageId: string }>
  searchParams?: Promise<{ returnTo?: string | string[] }>
}

export default async function ClientPackagePreviewPage({ params, searchParams }: Props) {
  noStore()
  const { venueId, packageId } = await params
  const query = searchParams ? await searchParams : {}
  const returnHref = resolveOnboardingReturn(query.returnTo, venueId, 'PREVIEW')
  const caller = await createDashboardCaller(`/venues/${venueId}/preview/${packageId}`)
  const lifecycle = (await caller.portal.getVenueLifecycles()).find(
    (row) => row.venueId === venueId,
  )
  if (
    !lifecycle ||
    lifecycle.lifecycle.state !== 'CLIENT_PREVIEW' ||
    lifecycle.clientPreview.state !== 'AVAILABLE' ||
    lifecycle.clientPreview.id !== packageId
  ) {
    return (
      <PreviewUnavailable
        venueId={venueId}
        superseded={lifecycle?.clientPreview.state === 'SUPERSEDED'}
        returnHref={returnHref}
      />
    )
  }
  try {
    const preview = await caller.portal.getClientPreview({ venueId, packageId })
    return <ClientPackagePreview preview={preview} returnHref={returnHref} />
  } catch (error) {
    if (previewErrorCode(error) === 'CONFLICT') {
      return <PreviewUnavailable venueId={venueId} superseded returnHref={returnHref} />
    }
    throw error
  }
}

function previewErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  if ('data' in error) {
    const data = error.data
    if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'string') {
      return data.code
    }
  }
  return 'code' in error && typeof error.code === 'string' ? error.code : null
}

function PreviewUnavailable({
  venueId,
  superseded,
  returnHref,
}: {
  venueId: string
  superseded: boolean
  returnHref: string
}) {
  return (
    <div className="min-h-screen px-4 py-10 sm:px-6 lg:px-10">
      <section
        className="mx-auto max-w-2xl rounded-[2rem] border border-pf-light bg-white p-8 text-center shadow-sm"
        role="status"
      >
        <p className="text-sm font-semibold text-pf-primary">Preview update</p>
        <h1 className="mt-2 text-2xl font-semibold text-pf-deep">
          {superseded ? 'An updated preview is being prepared' : 'This preview is not available'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-pf-deep/70">
          {superseded
            ? 'The approved experience changed after this link was created. Torchiko will provide a new exact preview when it is ready.'
            : 'Return to your portal to see the latest status for this venue.'}
        </p>
        <Link
          href={returnHref ?? `/?venue=${encodeURIComponent(venueId)}`}
          className="mt-5 inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white"
        >
          Return to onboarding journey
        </Link>
      </section>
    </div>
  )
}
