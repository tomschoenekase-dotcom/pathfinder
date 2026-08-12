export const dynamic = 'force-dynamic'

import { IntakeProposalWorkspace } from '../../../../../components/IntakeProposalWorkspace'
import { IntakeFileUploadWorkspace } from '../../../../../components/IntakeFileUpload'
import { createDashboardCaller } from '../../../../../lib/server-caller'

export default async function IntakePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params
  const caller = await createDashboardCaller(`/venues/${venueId}/intake`)
  const [proposals, uploadPage] = await Promise.all([
    caller.intake.listProposals({ venueId, limit: 25 }),
    caller.intakeUpload.list({ venueId, limit: 25 }),
  ])
  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <p className="text-xs font-bold uppercase tracking-wider text-pf-primary">
            Build your PathFinder
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-pf-deep">Share what you already have</h1>
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">
            Websites, written staff knowledge, documents, and images are all useful. Rough source
            material is welcome—the PathFinder team reviews everything before it becomes part of the
            visitor experience. This page shows your 25 most recently shared files.
          </p>
        </header>
        <IntakeProposalWorkspace venueId={venueId} proposals={proposals} />
        <IntakeFileUploadWorkspace venueId={venueId} uploads={uploadPage.items} />
      </div>
    </main>
  )
}
