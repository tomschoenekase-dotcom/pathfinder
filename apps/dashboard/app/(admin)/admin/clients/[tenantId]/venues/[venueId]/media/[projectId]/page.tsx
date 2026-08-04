export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { MediaIngestionReview } from '../../../../../../../../../components/admin/MediaIngestionReview'
import { createAdminCaller } from '../../../../../../../../../lib/admin-caller'

export default async function AdminMediaProjectPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string; projectId: string }>
}) {
  const { tenantId, venueId, projectId } = await params
  const caller = await createAdminCaller()
  const project = await caller.mediaIngestion.get({ tenantId, projectId })

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}/media`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        ← All media intakes
      </Link>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">{project.name}</h1>
          <span className="rounded-full bg-pf-primary/10 px-3 py-1 text-xs font-semibold text-pf-primary">
            {project.status.replace(/_/g, ' ').toLowerCase()}
          </span>
        </div>
        <p className="text-sm text-pf-deep/60">
          {project.sourceFileName ?? 'No archive'} · stage {project.stage} · {project.progress}%
        </p>
        {project.error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {project.error}
          </p>
        ) : null}
      </header>
      {project.draftJson ? (
        <MediaIngestionReview
          tenantId={tenantId}
          projectId={projectId}
          initialQuestions={project.questions}
          initialDraft={project.draftJson}
        />
      ) : (
        <div className="rounded-2xl border border-pf-light bg-pf-white p-8 text-sm text-pf-deep/60 shadow-sm">
          Analysis is still running. Refresh this page to see updated progress and the review draft.
        </div>
      )}
    </div>
  )
}
