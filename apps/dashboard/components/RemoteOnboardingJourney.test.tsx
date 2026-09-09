/* @vitest-environment jsdom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./IntakeFileUpload', () => ({
  IntakeFileUploadWorkspace: ({ venueCategory }: { venueCategory?: string | null }) => (
    <div data-venue-category={venueCategory ?? 'generic'}>
      Types of data to submit · Videos or audio · 50 GB total
    </div>
  ),
}))
vi.mock('./IntakeProposalWorkspace', () => ({
  IntakeProposalWorkspace: () => <div>Website or staff contribution form</div>,
}))
vi.mock('./IntakeV1SubmissionWorkspace', () => ({
  IntakeV1SubmissionWorkspace: () => <div>Website or staff contribution form</div>,
}))
vi.mock('./IntakeCorrectionForm', () => ({
  IntakeCorrectionForm: ({ sourceLabel }: { sourceLabel: string }) => (
    <button>Suggest a correction to {sourceLabel}</button>
  ),
}))
vi.mock('./IntakeProposalReview', () => ({
  IntakeProposalReview: () => <button>Review cited staff answers</button>,
}))

import { RemoteOnboardingJourney } from './RemoteOnboardingJourney'

const data = {
  venue: { id: 'venue-1', name: 'Museum', category: null },
  lifecycle: {
    version: 1 as const,
    state: 'COLLECTING' as const,
    label: 'Gathering information',
    headline: 'A little more information will help us continue.',
    summary: 'Share what you already have.',
    clientAction: 'CONTINUE_INTAKE' as const,
    clientActionRequired: true,
  },
  projection: {
    version: 4 as const,
    primaryAction: {
      kind: 'START_MATERIALS' as const,
      stage: 'MATERIALS' as const,
      label: 'Add another useful source',
      reason: 'A source will help Torchiko continue.',
      required: true,
    },
    stages: [
      {
        id: 'MATERIALS' as const,
        label: 'Materials',
        status: 'IN_PROGRESS' as const,
        summary: 'One file is being checked.',
      },
    ],
    readiness: [
      {
        id: 'SOURCES' as const,
        label: 'Source confidence',
        status: 'IN_PROGRESS' as const,
        summary: 'A source is being checked.',
      },
    ],
  },
  materials: {
    uploaded: 0,
    checking: 1,
    checksNeedAction: 0,
    checksWaitingOnTorchiko: 0,
    needsAttention: 0,
    readyForReview: 0,
    processed: 0,
  },
  review: { proposedSources: 0, draftPackages: 0 },
  questions: { open: 0, items: [], additionalQuestionCount: 0 },
  preview: { state: 'UNAVAILABLE' as const, packageId: null },
  qa: {
    state: 'NOT_RUN' as const,
    passed: 0,
    failed: 0,
    operationalIssues: 0,
    requiredDimensions: 7,
    assessedDimensions: 0,
    exactPackage: false,
  },
  release: { hasReviewedArtifact: false, released: false },
  publication: {
    clientCanPublish: false as const,
    summary: 'Nothing goes live from this page. The Torchiko team handles release separately.',
  },
}

function markupRoot(html: string) {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('RemoteOnboardingJourney', () => {
  it('passes the saved venue category to capture guidance without inferring from its name', () => {
    const museum = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{ ...data, venue: { ...data.venue, category: 'Museum' } }}
        />,
      ),
    )
    const unnamed = markupRoot(
      renderToStaticMarkup(<RemoteOnboardingJourney ownerId="test-owner" data={data} />),
    )
    expect(museum.querySelector('[data-venue-category]')?.getAttribute('data-venue-category')).toBe(
      'Museum',
    )
    expect(
      unnamed.querySelector('[data-venue-category]')?.getAttribute('data-venue-category'),
    ).toBe('generic')
  })
  it('keeps disclosed source links touch-sized', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'components/RemoteOnboardingJourney.module.css'),
      'utf8',
    )
    expect(css).toMatch(/\.sourceLink\s*\{[\s\S]*?min-height:\s*2\.75rem;/u)
  })

  it('keeps upload primary while progressively disclosing the durable journey', () => {
    const html = renderToStaticMarkup(
      <RemoteOnboardingJourney
        ownerId="test-owner"
        data={data}
        proposals={[
          {
            id: 'run-1',
            sourceKind: 'INTERVIEW',
            status: 'AWAITING_REVIEW',
            displayName: 'Front desk interview',
            websiteUri: null,
            interviewRole: 'FRONTLINE_STAFF',
            createdAt: new Date('2030-01-01T00:00:00.000Z'),
            _count: { evidence: 3, events: 2 },
            packageHandoff: null,
          },
        ]}
        uploads={[
          {
            id: 'upload-1',
            displayName: 'tour.mp4',
            fileName: 'tour.mp4',
            mimeType: 'video/mp4',
            byteSize: 1024,
            category: 'VIDEO_AUDIO',
            status: 'PRECHECK_PASSED',
          },
        ]}
      />,
    )

    expect(html).toContain('A little more information will help us continue.')
    expect(html).toContain('id="materials"')
    expect(html).toContain('Types of data to submit')
    expect(html).toContain('Videos or audio')
    expect(html).toContain('50 GB total')
    expect(html).toContain('Add a website, staff knowledge, or optional notes')
    expect(html).toContain('Visitor preview')
    expect(html).toContain('3 supporting reference(s)')
    expect(html).toContain('Where this came from')
    expect(html).toContain('Review cited staff answers')
    expect(html).toContain('Suggest a correction to Front desk interview')
    expect(html).toContain('Request guide appearance')
    expect(html).toContain('Source confidence')
    expect(html).toContain('View full journey status')
    expect(html).toContain(
      'Nothing goes live from this page. The Torchiko team handles release separately.',
    )
  })

  it('links an optional appearance request to the exact venue and review return point', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{
            ...data,
            projection: {
              ...data.projection,
              primaryAction: {
                kind: 'REVIEW_SOURCES' as const,
                stage: 'REVIEW' as const,
                label: 'Review organized information',
                reason: 'Your saved information is ready for review.',
                required: false,
              },
            },
            review: { proposedSources: 1, draftPackages: 0 },
          }}
        />,
      ),
    )
    const link = Array.from(root.querySelectorAll<HTMLAnchorElement>('a')).find((item) =>
      item.textContent?.includes('Request guide appearance'),
    )
    const href = new URL(link?.getAttribute('href') ?? '', 'https://portal.invalid')

    expect(href.pathname).toBe('/support')
    expect(href.searchParams.get('venue')).toBe('venue-1')
    expect(href.searchParams.get('new')).toBe('theme-preference')
    expect(href.searchParams.get('returnTo')).toBe('/venues/venue-1/onboarding#review')
    expect(root.querySelector('#review')?.textContent).toContain('share it for review')
    expect(root.querySelector('#review')?.textContent).toContain(
      'requesting a preference does not change the guide',
    )
  })

  it('renders the five-stage client journey with one truthful current step', () => {
    const root = markupRoot(
      renderToStaticMarkup(<RemoteOnboardingJourney ownerId="test-owner" data={data} />),
    )
    const rail = root.querySelector('section[aria-label="Onboarding progress"]')

    expect(rail).not.toBeNull()
    expect(rail?.querySelectorAll('li')).toHaveLength(5)
    expect(rail?.textContent).toContain('Welcome')
    expect(rail?.textContent).toContain('Share')
    expect(rail?.textContent).toContain('Processing')
    expect(rail?.textContent).toContain('Questions')
    expect(rail?.textContent).toContain('Ready')
    expect(rail?.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
    expect(rail?.querySelector('[aria-current="step"]')?.textContent).toContain('Share')
  })

  it('does not spend client attention on an empty questions section', () => {
    const root = markupRoot(
      renderToStaticMarkup(<RemoteOnboardingJourney ownerId="test-owner" data={data} />),
    )

    expect(root.querySelector('#questions')).toBeNull()
    expect(root.textContent).not.toContain('Focused questions')
    expect(root.textContent).toContain('Nothing needs an answer right now.')
  })

  it('shows a truthful resumable checkpoint after a submitted website or staff source', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{
            ...data,
            projection: {
              ...data.projection,
              primaryAction: {
                kind: 'REVIEW_SOURCES' as const,
                stage: 'REVIEW' as const,
                label: 'See what you shared',
                reason:
                  'Your information is saved for Torchiko review. You can add a correction now or return later.',
                required: false,
              },
            },
            review: { proposedSources: 1, draftPackages: 0 },
          }}
        />,
      ),
    )

    expect(root.querySelector('#saved-progress-title')?.textContent).toContain(
      'Your onboarding progress will be here when you return.',
    )
    expect(root.textContent).toContain('2 shared sources recorded for Museum.')
    expect(root.textContent).toContain(
      'Nothing else is required right now. You can close this page and return later.',
    )
    expect(root.textContent).toContain(
      'Unfinished website, staff, and note entries save privately while you work.',
    )
    expect(root.textContent).not.toContain('Unfinished entries are not saved until you share them.')
    const activity = root.querySelector('[aria-label="Current onboarding activity"]')
    expect(activity?.textContent).toContain('Shared2')
    expect(activity?.textContent).toContain('Ready for Torchiko1')
  })

  it('anchors an informational next-step action to the saved return checkpoint', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{
            ...data,
            projection: {
              ...data.projection,
              primaryAction: {
                kind: 'VIEW_PROGRESS' as const,
                stage: 'OVERVIEW' as const,
                label: 'See what happens next',
                reason:
                  'Your information is saved and being checked. You can leave this page and return later.',
                required: false,
              },
            },
          }}
        />,
      ),
    )

    expect(root.querySelector('a[href="#saved-progress"]')?.textContent).toContain(
      'See what happens next',
    )
    expect(root.querySelector('#saved-progress')).not.toBeNull()
  })

  it('keeps the review action anchored while organized information is still being prepared', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{
            ...data,
            projection: {
              ...data.projection,
              primaryAction: {
                kind: 'REVIEW_SOURCES' as const,
                stage: 'REVIEW' as const,
                label: 'Review organized information',
                reason: 'Torchiko is organizing the submitted sources.',
                required: false,
              },
            },
            review: { proposedSources: 0, draftPackages: 1 },
          }}
        />,
      ),
    )
    expect(root.querySelector('a[href="#review"]')).not.toBeNull()
    expect(root.querySelector('#review')).not.toBeNull()
    expect(root.querySelector('#review')?.textContent).toContain(
      'There is nothing ready for you to review yet',
    )
  })

  it('links a focused question to its exact durable discussion and return point', () => {
    const html = renderToStaticMarkup(
      <RemoteOnboardingJourney
        ownerId="test-owner"
        data={{
          ...data,
          questions: {
            open: 1,
            items: [
              {
                requestId: 'request-7',
                subject: 'Saturday hours',
                prompts: ['What time do you close?'],
                additionalPromptCount: 0,
                context: {
                  version: 1,
                  why: 'The current visitor information gives two closing times.',
                  whatWasFound: 'The public calendar says 4 p.m.; the guide says 5 p.m.',
                  effect: 'Your answer lets Torchiko keep Saturday guidance accurate.',
                },
              },
            ],
            additionalQuestionCount: 0,
          },
        }}
      />,
    )
    const root = markupRoot(html)
    const link = root.querySelector<HTMLAnchorElement>('#questions a')
    expect(link).not.toBeNull()
    const href = new URL(link?.getAttribute('href') ?? '', 'https://portal.invalid')
    expect(href.pathname).toBe('/support')
    expect(href.searchParams.get('venue')).toBe('venue-1')
    expect(href.searchParams.get('request')).toBe('request-7')
    expect(href.searchParams.get('returnTo')).toBe('/venues/venue-1/onboarding#questions')
    expect(root.querySelector('#questions')?.textContent).toContain(
      'The current visitor information gives two closing times.',
    )
    expect(root.querySelector('#questions')?.textContent).toContain(
      'The public calendar says 4 p.m.; the guide says 5 p.m.',
    )
    expect(root.querySelector('#questions')?.textContent).toContain(
      'Your answer lets Torchiko keep Saturday guidance accurate.',
    )
    expect(root.querySelector('#questions')?.textContent).toContain(
      'If you are not sure, say so in the conversation so Torchiko can follow up.',
    )
  })

  it('makes a bounded hidden-question remainder transparent with singular and plural copy', () => {
    const questions = [
      {
        requestId: 'request-1',
        subject: 'Entrance',
        prompts: ['Which entrance is step-free?'],
        additionalPromptCount: 0,
      },
      {
        requestId: 'request-2',
        subject: 'Hours',
        prompts: ['Which days are you open?'],
        additionalPromptCount: 0,
      },
      {
        requestId: 'request-3',
        subject: 'Restrooms',
        prompts: ['Where are accessible restrooms?'],
        additionalPromptCount: 0,
      },
    ]

    const singular = renderToStaticMarkup(
      <RemoteOnboardingJourney
        ownerId="test-owner"
        data={{
          ...data,
          questions: { open: 4, items: questions, additionalQuestionCount: 1 },
        }}
      />,
    )
    const plural = renderToStaticMarkup(
      <RemoteOnboardingJourney
        ownerId="test-owner"
        data={{
          ...data,
          questions: { open: 28, items: questions, additionalQuestionCount: 25 },
        }}
      />,
    )

    expect(singular).toContain('1 more focused question is waiting.')
    expect(plural).toContain('25 more focused questions are waiting.')
    expect(plural.match(/Answer this question/g)).toHaveLength(3)
  })

  it('offers only an available exact preview and keeps release outside client control', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{
            ...data,
            projection: {
              ...data.projection,
              primaryAction: {
                kind: 'TEST_PREVIEW' as const,
                stage: 'PREVIEW' as const,
                label: 'Review the visitor experience',
                reason: 'A reviewed candidate is ready for your feedback.',
                required: true,
              },
            },
            preview: { state: 'AVAILABLE' as const, packageId: 'package-7' },
          }}
        />,
      ),
    )
    const previewLink = Array.from(root.querySelectorAll<HTMLAnchorElement>('a')).find((link) =>
      link.textContent?.includes('Test the visitor preview'),
    )

    expect(previewLink).toBeDefined()
    expect(previewLink?.getAttribute('href')).toBe(
      '/venues/venue-1/preview/package-7?returnTo=%2Fvenues%2Fvenue-1%2Fonboarding%23preview',
    )
    expect(root.querySelector('#readiness')?.textContent).toContain('Source confidence')
    expect(root.textContent).toContain(
      'Nothing goes live from this page. The Torchiko team handles release separately.',
    )
    expect(
      Array.from(root.querySelectorAll('a,button')).some((control) =>
        /publish|release now|go live/iu.test(control.textContent ?? ''),
      ),
    ).toBe(false)
  })

  it('withholds a superseded preview even when a stale package identifier is present', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{
            ...data,
            preview: { state: 'SUPERSEDED' as const, packageId: 'stale-package' },
          }}
        />,
      ),
    )

    expect(root.textContent).toContain('A previous preview is out of date.')
    expect(root.textContent).not.toContain('Test the visitor preview')
    expect(root.querySelector('a[href*="stale-package"]')).toBeNull()
  })

  it('links a rejected source to the exact replacement recovery target', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{
            ...data,
            projection: {
              ...data.projection,
              primaryAction: {
                kind: 'CHOOSE_REPLACEMENT' as const,
                stage: 'MATERIALS' as const,
                label: 'Choose a replacement file',
                reason:
                  '1 file could not be accepted. Other submitted information remains unchanged.',
                required: true,
              },
            },
            materials: {
              uploaded: 0,
              checking: 0,
              checksNeedAction: 0,
              checksWaitingOnTorchiko: 0,
              needsAttention: 1,
              readyForReview: 1,
              processed: 0,
            },
          }}
        />,
      ),
    )

    expect(root.querySelector('a[href="#material-attention"]')?.textContent).toContain(
      'Choose a replacement file',
    )
    expect(root.textContent).toContain(
      'Choose a replacement for each file Torchiko could not accept.',
    )
    expect(root.querySelector('[aria-current="step"]')?.textContent).toContain('Share')
  })

  it('links an expired saved-file check to the exact resumption target', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
          ownerId="test-owner"
          data={{
            ...data,
            projection: {
              ...data.projection,
              primaryAction: {
                kind: 'RESUME_MATERIAL_CHECK' as const,
                stage: 'MATERIALS' as const,
                label: 'Resume file check',
                reason: '1 saved file needs the check resumed. You do not need to upload it again.',
                required: true,
              },
            },
            materials: {
              ...data.materials,
              checking: 0,
              checksNeedAction: 1,
            },
          }}
          uploads={[
            {
              id: 'expired-check',
              displayName: 'visitor-guide.pdf',
              fileName: 'visitor-guide.pdf',
              mimeType: 'application/pdf',
              byteSize: 8,
              status: 'VERIFYING',
              clientVerification: {
                kind: 'RESUME_CHECK',
                required: true,
                actionLabel: 'Resume file check',
                reason: 'The saved file check stopped before it finished.',
                retrySameSubmission: true,
              },
            },
          ]}
        />,
      ),
    )

    expect(root.querySelector('a[href="#material-attention"]')?.textContent).toContain(
      'Resume file check',
    )
    expect(root.textContent).toContain('You do not need to upload it again.')
    expect(root.querySelector('[aria-current="step"]')?.textContent).toContain('Share')
  })

  it('keeps internal workflow jargon out of the primary client journey', () => {
    const root = markupRoot(
      renderToStaticMarkup(<RemoteOnboardingJourney ownerId="test-owner" data={data} />),
    )
    const clientCopy = root.textContent ?? ''

    expect(clientCopy).not.toMatch(
      /queue|worker|pipeline|agent run|package id|tenant id|quarantine|checksum|deployment manifest|source version|immutable evidence|workflow evidence|internal readiness/iu,
    )
  })
})
