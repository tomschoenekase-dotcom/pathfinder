import { describe, expect, it } from 'vitest'
import { resolveClientPortalLifecycle } from '@pathfinder/contracts/client-portal-lifecycle'

import { buildPortalHomeTasks, type PortalHomeTaskEvidence } from './portal-home-tasks'

const evidence = (overrides: Partial<PortalHomeTaskEvidence> = {}): PortalHomeTaskEvidence => ({
  missingInformation: [],
  additionalMissingRequest: false,
  hasSharedInformation: false,
  latestReport: null,
  ...overrides,
})

const lifecycleFrom = (overrides: Partial<Parameters<typeof resolveClientPortalLifecycle>[0]>) =>
  resolveClientPortalLifecycle({
    isActive: false,
    publicContentCount: 0,
    wasLive: false,
    collectingSourceCount: 0,
    processingSourceCount: 0,
    reviewSourceCount: 0,
    intakeProposalCount: 0,
    packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
    hasActiveOffboarding: false,
    ...overrides,
  })

describe('buildPortalHomeTasks', () => {
  it('puts specific information requests first, then lifecycle work, then optional reading', () => {
    const tasks = buildPortalHomeTasks({
      venueId: 'venue / one',
      lifecycle: lifecycleFrom({ reviewSourceCount: 1 }),
      clientPreview: { state: 'UNAVAILABLE', id: null },
      chatUrl: null,
      evidence: evidence({
        missingInformation: [
          {
            requestId: 'req 1',
            subject: 'Winter hours',
            items: ['Closing time'],
            additionalItemCount: 0,
          },
        ],
        additionalMissingRequest: true,
        latestReport: { id: 'report-1', title: 'September review' },
      }),
    })
    expect(tasks.map((task) => [task.kind, task.required])).toEqual([
      ['information-request', true],
      ['information-request', true],
      ['progress', false],
      ['report', false],
    ])
    expect(tasks[0]).toMatchObject({
      title: 'Winter hours',
      href: '/support?venue=venue%20%2F%20one&request=req%201',
      items: ['Closing time'],
    })
    expect(tasks[0]).not.toHaveProperty('additionalItemCount')
  })

  it('asks a first-time venue for starting information and a ready venue for a final look', () => {
    const setup = buildPortalHomeTasks({
      venueId: 'v1',
      lifecycle: lifecycleFrom({}),
      clientPreview: { state: 'UNAVAILABLE', id: null },
      chatUrl: 'https://guide.example/v1/chat',
      evidence: evidence(),
    })
    expect(setup).toEqual([
      expect.objectContaining({
        kind: 'share-information',
        title: 'Share your starting information',
        href: '/venues/v1/onboarding',
      }),
    ])

    const ready = buildPortalHomeTasks({
      venueId: 'v1',
      lifecycle: lifecycleFrom({
        publicContentCount: 1,
        packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 },
      }),
      clientPreview: { state: 'UNAVAILABLE', id: null },
      chatUrl: 'https://guide.example/v1/chat',
      evidence: evidence({ hasSharedInformation: true }),
    })
    expect(ready).toEqual([
      expect.objectContaining({ kind: 'preview', href: 'https://guide.example/v1/chat' }),
    ])
  })

  it('opens only an available client preview and caps the list at six', () => {
    const tasks = buildPortalHomeTasks({
      venueId: 'v1',
      lifecycle: lifecycleFrom({
        packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
      }),
      clientPreview: { state: 'AVAILABLE', id: 'pkg 1' },
      chatUrl: 'https://guide.example/v1/chat',
      evidence: evidence({
        missingInformation: Array.from({ length: 6 }, (_, index) => ({
          requestId: `r${index}`,
          subject: `Question ${index}`,
          items: [],
          additionalItemCount: 0,
        })),
      }),
    })
    expect(tasks).toHaveLength(6)
    expect(tasks.some((task) => task.kind === 'preview')).toBe(false)

    const preview = buildPortalHomeTasks({
      venueId: 'v1',
      lifecycle: lifecycleFrom({
        packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
      }),
      clientPreview: { state: 'AVAILABLE', id: 'pkg 1' },
      chatUrl: 'https://guide.example/v1/chat',
      evidence: evidence(),
    })
    expect(preview[0]).toMatchObject({ kind: 'preview', href: '/venues/v1/preview/pkg%201' })
  })
})
