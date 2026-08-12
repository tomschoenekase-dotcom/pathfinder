export const dynamic = 'force-dynamic'

import { IntakeProposalWorkspace } from '../../../../../../../../components/IntakeProposalWorkspace'
import { IntakeUploadReviewList } from '../../../../../../../../components/admin/IntakeUploadReviewList'
import { OnboardingBootstrapReview } from '../../../../../../../../components/admin/OnboardingBootstrapReview'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type PageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{ uploadCreatedAt?: string; uploadId?: string }>
}

export default async function AdminIntakePage({ params, searchParams }: PageProps) {
  const { tenantId, venueId } = await params
  const query = await searchParams
  const uploadCursor =
    query.uploadCreatedAt && query.uploadId
      ? { createdAt: query.uploadCreatedAt, id: query.uploadId }
      : undefined
  const caller = await createAdminCaller()
  let proposals
  let onboardingDetails
  let intakeUploads
  try {
    proposals = await caller.admin.listIntakeProposals({ tenantId, venueId, limit: 50 })
    onboardingDetails = await caller.admin.listOnboardingBootstrapDetails({
      tenantId,
      venueId,
      limit: 50,
    })
    intakeUploads = await caller.admin.listIntakeUploads({
      tenantId,
      venueId,
      limit: 50,
      ...(uploadCursor ? { cursor: uploadCursor } : {}),
    })
  } catch {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6" role="alert">
        <h2 className="text-lg font-semibold text-rose-950">Intake workspace unavailable</h2>
        <p className="mt-2 text-sm text-rose-900">
          The exact client and venue scope could not be loaded. No proposal was created.
        </p>
      </section>
    )
  }

  return (
    <div className="space-y-7">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Operator-assisted onboarding
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          Guided intake proposals
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Review client-submitted starting information, record a website address without fetching
          it, or collect consented structured staff answers. Every result remains an append-only
          proposal awaiting package review; nothing is approved, applied, or published here.
        </p>
      </header>
      <IntakeProposalWorkspace adminTenantId={tenantId} venueId={venueId} proposals={proposals} />
      <IntakeUploadReviewList uploads={intakeUploads.items} />
      {intakeUploads.nextCursor ? (
        <a
          className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-white px-4 py-2 text-sm font-medium text-pf-deep"
          href={`?uploadCreatedAt=${encodeURIComponent(intakeUploads.nextCursor.createdAt)}&uploadId=${encodeURIComponent(intakeUploads.nextCursor.id)}`}
        >
          View older quarantined submissions
        </a>
      ) : null}
      {onboardingDetails.length > 0 ? (
        <section
          className="rounded-2xl border border-pf-light bg-white p-5"
          aria-labelledby="bootstrap-review-title"
        >
          <h3 id="bootstrap-review-title" className="font-semibold text-pf-deep">
            Onboarding information awaiting review
          </h3>
          <p className="mt-1 text-sm text-pf-deep/75">
            Private raw proposals only. These values have not been added to the visitor guide.
          </p>
          <ul className="mt-4 space-y-4">
            {onboardingDetails.map((detail) => (
              <li key={detail.id}>
                <OnboardingBootstrapReview tenantId={tenantId} venueId={venueId} run={detail} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
