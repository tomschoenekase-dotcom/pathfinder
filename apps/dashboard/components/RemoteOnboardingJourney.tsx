import Link from 'next/link'
import React from 'react'
import { ArrowRight, Check, Eye, MessageCircle, ShieldCheck } from 'lucide-react'
import type { ClientPortalLifecycleView } from '@pathfinder/contracts/client-portal-lifecycle'
import type { IntakeUploadCategory } from '@pathfinder/contracts/intake-upload'
import type { RemoteOnboardingProjection } from '@pathfinder/contracts/remote-onboarding'

import { ClientJourneyRail, PortalPrimaryAction } from './ClientPortalPrimitives'
import type { ClientJourneyStage, TorchikoCoreState } from './ClientPortalPrimitives'
import { IntakeFileUploadWorkspace } from './IntakeFileUpload'
import { IntakeCorrectionForm } from './IntakeCorrectionForm'
import { IntakeProposalReview } from './IntakeProposalReview'
import { IntakeProposalWorkspace, type IntakeProposalSummary } from './IntakeProposalWorkspace'
import styles from './RemoteOnboardingJourney.module.css'

type JourneyData = {
  venue: { id: string; name: string }
  lifecycle: ClientPortalLifecycleView
  projection: RemoteOnboardingProjection
  materials: {
    uploaded: number
    checking: number
    needsAttention: number
    readyForReview: number
    processed: number
  }
  materialTypes?: Partial<Record<IntakeUploadCategory, number>> | undefined
  review: { proposedSources: number; draftPackages: number }
  questions: {
    open: number
    items: Array<{
      requestId: string
      subject: string
      prompts: string[]
      additionalPromptCount: number
    }>
    additionalQuestionCount: number
  }
  preview: { state: 'AVAILABLE' | 'SUPERSEDED' | 'UNAVAILABLE'; packageId: string | null }
  qa: {
    state: 'NOT_RUN' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
    passed: number
    failed: number
    operationalIssues: number
    safetyCriticalFailed?: number
    requiredDimensions: number
    assessedDimensions: number
    exactPackage: boolean
  }
  release: { hasReviewedArtifact: boolean; released: boolean }
  publication: { clientCanPublish: false; summary: string }
}

type SafeUpload = {
  id: string
  displayName: string
  fileName: string
  mimeType: string
  byteSize: number
  category?: string
  status: string
  rejectionCode?: string | null
}

function statusLabel(status: string) {
  return status.replaceAll('_', ' ').toLowerCase()
}

function websiteLabel(uri: string) {
  try {
    return new URL(uri).hostname
  } catch {
    return 'Shared website'
  }
}

function primaryHref(data: JourneyData) {
  const home = `/venues/${data.venue.id}/onboarding`
  switch (data.projection.primaryAction.stage) {
    case 'MATERIALS':
      return '#materials'
    case 'REVIEW':
      return '#review'
    case 'QUESTIONS':
      return '#questions'
    case 'PREVIEW':
      return data.preview.state === 'AVAILABLE' && data.preview.packageId
        ? `/venues/${data.venue.id}/preview/${data.preview.packageId}?returnTo=${encodeURIComponent(`${home}#preview`)}`
        : '#preview'
    case 'READINESS':
      return '#readiness'
    default:
      return '#overview'
  }
}

function clientJourney(data: JourneyData): {
  stages: ClientJourneyStage[]
  coreState: TorchikoCoreState
} {
  const primaryIndex =
    data.release.released || data.lifecycle.state === 'LIVE' || data.lifecycle.state === 'READY'
      ? 4
      : data.projection.primaryAction.stage === 'QUESTIONS'
        ? 3
        : data.projection.primaryAction.stage === 'PREVIEW' ||
            data.projection.primaryAction.stage === 'READINESS'
          ? 4
          : data.projection.primaryAction.stage === 'OVERVIEW' ||
              data.projection.primaryAction.stage === 'REVIEW' ||
              data.lifecycle.state === 'PROCESSING' ||
              data.lifecycle.state === 'INTERNAL_REVIEW'
            ? 2
            : 1
  const labels = [
    { id: 'welcome', label: 'Welcome', summary: 'Know what happens next.' },
    { id: 'share', label: 'Share', summary: 'Give us what you already have.' },
    { id: 'processing', label: 'Processing', summary: 'We organize and check it.' },
    { id: 'questions', label: 'Questions', summary: 'Answer only what is missing.' },
    { id: 'ready', label: 'Ready', summary: 'Review the visitor experience.' },
  ]
  const stages = labels.map((stage, index) => ({
    ...stage,
    status: (index < primaryIndex
      ? 'complete'
      : index === primaryIndex
        ? 'current'
        : 'upcoming') as ClientJourneyStage['status'],
  }))
  const coreState: TorchikoCoreState =
    data.lifecycle.state === 'LIVE'
      ? 'live'
      : primaryIndex === 4
        ? 'ready'
        : primaryIndex === 3
          ? 'questions'
          : primaryIndex === 2
            ? 'processing'
            : primaryIndex === 1
              ? 'share'
              : 'welcome'
  return { stages, coreState }
}

export function RemoteOnboardingJourney({
  data,
  uploads = [],
  nextCursor = null,
  proposals = [],
}: {
  data: JourneyData
  uploads?: SafeUpload[]
  nextCursor?: { createdAt: string; id: string } | null
  proposals?: IntakeProposalSummary[]
}) {
  const onboardingHref = `/venues/${data.venue.id}/onboarding`
  const supportHref = `/support?${new URLSearchParams({
    venue: data.venue.id,
    returnTo: onboardingHref,
  })}`
  const previewHref =
    data.preview.state === 'AVAILABLE' && data.preview.packageId
      ? `/venues/${data.venue.id}/preview/${data.preview.packageId}?returnTo=${encodeURIComponent(`${onboardingHref}#preview`)}`
      : null
  const journey = clientJourney(data)
  const recordedMaterialCount =
    data.materials.uploaded +
    data.materials.checking +
    data.materials.needsAttention +
    data.materials.readyForReview +
    data.materials.processed
  const organizedCount = data.review.proposedSources + data.review.draftPackages

  return (
    <div className={styles.page}>
      <div className={styles.frame}>
        <div id="overview" className="scroll-mt-20">
          <PortalPrimaryAction
            headingId="onboarding-title"
            eyebrow={`Torchiko for ${data.venue.name}`}
            title={data.lifecycle.headline}
            summary={data.lifecycle.summary}
            primaryAction={{
              href: primaryHref(data),
              label: data.projection.primaryAction.label,
            }}
            secondaryAction={{ href: supportHref, label: 'Ask Torchiko for help' }}
            supportingText={data.projection.primaryAction.reason}
            state={journey.coreState}
          />
        </div>

        <div className={styles.stageBand}>
          <ClientJourneyRail stages={journey.stages} compact />
        </div>

        <div id="materials" className={styles.materials}>
          <IntakeFileUploadWorkspace
            venueId={data.venue.id}
            uploads={uploads}
            categoryCounts={data.materialTypes}
            nextCursor={nextCursor}
          />
          <details className={styles.sourceDetails}>
            <summary>Share a website or staff knowledge</summary>
            <p className={styles.detailsIntro}>
              A website or a few staff answers can be the fastest starting point. Sharing them does
              not publish anything to visitors.
            </p>
            <IntakeProposalWorkspace venueId={data.venue.id} proposals={proposals} />
          </details>
        </div>

        {data.questions.items.length ? (
          <section
            id="questions"
            aria-labelledby="questions-title"
            className={styles.questionCallout}
          >
            <div>
              <p className={styles.sectionEyebrow}>A small thing only you can answer</p>
              <h2 id="questions-title">Focused questions</h2>
              <p className={styles.reviewIntro}>
                Torchiko asks only when a missing detail would materially improve a visitor answer.
              </p>
            </div>
            <ul className={styles.questionList}>
              {data.questions.items.map((question) => (
                <li key={question.requestId} className={styles.questionItem}>
                  <h3>{question.subject}</h3>
                  <ul>
                    {question.prompts.map((prompt) => (
                      <li key={prompt}>{prompt}</li>
                    ))}
                  </ul>
                  {question.additionalPromptCount ? (
                    <p className={styles.sourceMeta}>
                      {question.additionalPromptCount} more detail
                      {question.additionalPromptCount === 1 ? '' : 's'} in this conversation
                    </p>
                  ) : null}
                  <Link
                    href={`/support?${new URLSearchParams({
                      venue: data.venue.id,
                      request: question.requestId,
                      returnTo: `${onboardingHref}#questions`,
                    })}`}
                    className={styles.questionLink}
                  >
                    Answer this question <ArrowRight aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className={styles.progressStrip} aria-label="Current onboarding activity">
          <div>
            <span>Shared</span>
            <strong>{recordedMaterialCount}</strong>
            <p>Material records are safely attached to this venue.</p>
          </div>
          <div>
            <span>Being organized</span>
            <strong>{data.materials.checking + organizedCount}</strong>
            <p>Checks and review stay truthful; Torchiko does not invent precise progress.</p>
          </div>
          <div>
            <span>Your attention</span>
            <strong>{data.materials.needsAttention + data.questions.open}</strong>
            <p>
              {data.questions.open
                ? 'A focused answer can move setup forward.'
                : 'Nothing needs an answer right now.'}
            </p>
          </div>
        </section>

        {proposals.length || data.projection.primaryAction.stage === 'REVIEW' ? (
          <section id="review" aria-labelledby="review-title" className={styles.reviewSection}>
            <p className={styles.sectionEyebrow}>Organized from your sources</p>
            <h2 id="review-title">Reviewable information</h2>
            <p className={styles.reviewIntro}>
              Torchiko keeps the supporting details behind each source. Corrections are added to the
              history instead of silently replacing what you shared.
            </p>
            {proposals.length ? (
              <ul className={styles.sourceList}>
                {proposals.slice(0, 5).map((proposal) => (
                  <li key={proposal.id} className={styles.sourceItem}>
                    <h3>{proposal.displayName}</h3>
                    <p className={styles.sourceMeta}>
                      {proposal.sourceKind === 'INTERVIEW' ? 'Staff knowledge' : 'Website source'} ·{' '}
                      {proposal._count.evidence} supporting reference(s) · {proposal._count.events}{' '}
                      update(s)
                    </p>
                    <details className={styles.sourceEvidence}>
                      <summary>Where this came from</summary>
                      <div>
                        {proposal.sourceKind === 'WEBSITE' && proposal.websiteUri ? (
                          <p>
                            Website shared for review:{' '}
                            <a
                              href={proposal.websiteUri}
                              target="_blank"
                              rel="noreferrer"
                              className={styles.sourceLink}
                            >
                              {websiteLabel(proposal.websiteUri)}
                            </a>
                          </p>
                        ) : (
                          <p>
                            Staff questionnaire shared on{' '}
                            {proposal.createdAt.toLocaleDateString('en-US')}.
                          </p>
                        )}
                        <p>
                          Torchiko keeps {proposal._count.evidence} supporting reference(s) with
                          this source. Corrections are added without erasing the earlier
                          information.
                        </p>
                      </div>
                      {proposal.sourceKind === 'INTERVIEW' ? (
                        <IntakeProposalReview
                          venueId={data.venue.id}
                          runId={proposal.id}
                          clientFacing
                        />
                      ) : null}
                    </details>
                    <IntakeCorrectionForm
                      venueId={data.venue.id}
                      runId={proposal.id}
                      expectedEventCount={proposal._count.events}
                      sourceLabel={proposal.displayName}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.reviewIntro} role="status">
                Torchiko is organizing the information already received. There is nothing ready for
                you to review yet; you can leave this page and return later.
              </p>
            )}
          </section>
        ) : null}

        <details id="journey-status" className={styles.traceDetails}>
          <summary>View full journey status</summary>
          <div className={styles.traceGrid}>
            <section id="preview" aria-labelledby="preview-title">
              <p className={styles.sectionEyebrow}>Before anything goes live</p>
              <h2 id="preview-title">Visitor preview</h2>
              <p className={styles.reviewIntro}>
                {previewHref
                  ? 'A reviewed candidate is ready. Test realistic visitor questions and send durable feedback.'
                  : data.preview.state === 'SUPERSEDED'
                    ? 'A previous preview is out of date. Torchiko is preparing the next reviewed candidate.'
                    : 'A preview appears after the information has been organized and reviewed.'}
              </p>
              {previewHref ? (
                <Link href={previewHref} className={styles.previewLink}>
                  <Eye aria-hidden="true" /> Test the visitor preview
                </Link>
              ) : (
                <Link href={supportHref} className={styles.supportLink}>
                  <MessageCircle aria-hidden="true" /> Ask about setup
                </Link>
              )}
              <p className={styles.publicationNote}>{data.publication.summary}</p>
            </section>
            <section id="readiness" aria-labelledby="readiness-title">
              <p className={styles.sectionEyebrow}>Exact, separate checks</p>
              <h2 id="readiness-title">Before launch</h2>
              <ul className={styles.readinessList}>
                {data.projection.readiness.map((item) => (
                  <li key={item.id}>
                    <div className={styles.traceRow}>
                      <strong>{item.label}</strong>
                      <span>
                        {item.status === 'READY' ? <Check aria-hidden="true" /> : null}
                        {statusLabel(item.status)}
                      </span>
                    </div>
                    <p>{item.summary}</p>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <ol className={styles.stageTrace} aria-label="Full onboarding history">
            {data.projection.stages.map((stage) => (
              <li key={stage.id}>
                <div className={styles.traceRow}>
                  <strong>{stage.label}</strong>
                  <span>
                    {stage.status === 'COMPLETE' ? (
                      <Check aria-hidden="true" />
                    ) : stage.status === 'NEEDS_ATTENTION' ? (
                      <ShieldCheck aria-hidden="true" />
                    ) : null}
                    {statusLabel(stage.status)}
                  </span>
                </div>
                <p>{stage.summary}</p>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </div>
  )
}
