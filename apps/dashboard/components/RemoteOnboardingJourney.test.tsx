/* @vitest-environment jsdom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./IntakeFileUpload', () => ({
  IntakeFileUploadWorkspace: () => (
    <div>Types of data to submit · Videos or audio · 50 GB total</div>
  ),
}))
vi.mock('./IntakeProposalWorkspace', () => ({
  IntakeProposalWorkspace: () => <div>Website or staff contribution form</div>,
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
  venue: { id: 'venue-1', name: 'Museum' },
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
    version: 3 as const,
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
  materials: { uploaded: 0, checking: 1, needsAttention: 0, readyForReview: 0, processed: 0 },
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
    expect(html).toContain('Source confidence')
    expect(html).toContain('View full journey status')
    expect(html).toContain(
      'Nothing goes live from this page. The Torchiko team handles release separately.',
    )
  })

  it('renders the five-stage client journey with one truthful current step', () => {
    const root = markupRoot(renderToStaticMarkup(<RemoteOnboardingJourney data={data} />))
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
    const root = markupRoot(renderToStaticMarkup(<RemoteOnboardingJourney data={data} />))

    expect(root.querySelector('#questions')).toBeNull()
    expect(root.textContent).not.toContain('Focused questions')
    expect(root.textContent).toContain('Nothing needs an answer right now.')
  })

  it('shows a truthful resumable checkpoint after a submitted website or staff source', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
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
    const activity = root.querySelector('[aria-label="Current onboarding activity"]')
    expect(activity?.textContent).toContain('Shared2')
    expect(activity?.textContent).toContain('Ready for Torchiko1')
  })

  it('anchors an informational next-step action to the saved return checkpoint', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
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
  })

  it('offers only an available exact preview and keeps release outside client control', () => {
    const root = markupRoot(
      renderToStaticMarkup(
        <RemoteOnboardingJourney
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

  it('keeps internal workflow jargon out of the primary client journey', () => {
    const root = markupRoot(renderToStaticMarkup(<RemoteOnboardingJourney data={data} />))
    const clientCopy = root.textContent ?? ''

    expect(clientCopy).not.toMatch(
      /queue|worker|pipeline|agent run|package id|tenant id|quarantine|checksum|deployment manifest|source version|immutable evidence|workflow evidence|internal readiness/iu,
    )
  })
})
