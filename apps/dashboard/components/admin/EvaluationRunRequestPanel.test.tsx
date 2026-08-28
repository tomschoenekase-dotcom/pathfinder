/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  listRuns: vi.fn(),
  listCases: vi.fn(),
  sourceCoverage: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      requestEvaluationRun: { mutate: mocks.mutate },
      listEvaluationRuns: { query: mocks.listRuns },
      listEvaluationCases: { query: mocks.listCases },
      previewCurrentEvaluationSourceCoverage: { query: mocks.sourceCoverage },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import {
  EvaluationRunRequestPanel,
  evaluationBudgetFromE8Usd,
  evaluationBudgetToE8Usd,
} from './EvaluationRunRequestPanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const item = {
  id: '11111111-1111-4111-8111-111111111111',
  caseKey: 'known-case',
  revision: 2,
  category: 'known-answer',
  schemaVersion: 'v1',
  sourceType: 'CURATED',
  createdAt: new Date(),
}
function renderPanel(enabled = true) {
  return render(
    <EvaluationRunRequestPanel
      tenantId="tenant-1"
      venueId="venue-1"
      initialCases={[item]}
      initialNextCursor={null}
      runnerEnabled={enabled}
      maximumCases={50}
    />,
  )
}

describe('EvaluationRunRequestPanel', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutate.mockResolvedValue({ enqueued: true })
    mocks.listRuns.mockResolvedValue({ items: [] })
    mocks.sourceCoverage.mockResolvedValue({
      target: 'CURRENT_LIVE_CONTENT',
      contentSnapshotHash: 'a'.repeat(64),
      contentVersion: '7',
      cases: [
        {
          caseId: item.id,
          caseKey: item.caseKey,
          revision: item.revision,
          coverage: {
            supportedMarkers: 1,
            totalMarkers: 2,
            markers: [
              {
                markerId: 'subject',
                kind: 'required-phrase',
                supported: true,
                matchedPhrase: 'Tide Clock',
              },
              {
                markerId: 'location',
                kind: 'required-fact',
                supported: false,
                matchedPhrase: null,
              },
            ],
          },
        },
      ],
    })
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue('request-key') })
  })
  it('keeps the request disabled when the server reports the dark flag', () => {
    renderPanel(false)
    expect(screen.getByText(/execution is dark/i)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Request run' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
  it('shows that automatic regression alerts require an explicit durable policy', () => {
    const { rerender } = renderPanel()
    expect(screen.getByText(/Automatic regression alerts are dark/)).toBeTruthy()

    rerender(
      <EvaluationRunRequestPanel
        tenantId="tenant-1"
        venueId="venue-1"
        initialCases={[item]}
        initialNextCursor={null}
        runnerEnabled
        maximumCases={50}
        regressionAlerts={{
          configured: true,
          minimumPassRateDrop: 0.08,
          errorPassRateDrop: 0.2,
        }}
      />,
    )
    expect(screen.getByText(/warning at a 8% pass-rate drop and error at 20%/)).toBeTruthy()
  })
  it('sends exact IDs, E8 budget, and an allow-listed model key without caller-controlled identities', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Budget ceiling'), { target: { value: '0.25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      idempotencyKey: 'request-key',
      caseIds: [item.id],
      budgetCeilingE8Usd: '25000000',
      modelKey: 'guest-chat',
    })
    expect(mocks.mutate.mock.calls[0]?.[0]).not.toHaveProperty('modelName')
    expect(mocks.mutate.mock.calls[0]?.[0]).not.toHaveProperty('contentSnapshotHash')
  })
  it('requests the explicit OpenAI provider-diversity candidate', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Evaluation model'), {
      target: { value: 'guest-chat-openai' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate.mock.calls[0]?.[0]).toMatchObject({ modelKey: 'guest-chat-openai' })
    expect(mocks.mutate.mock.calls[0]?.[0]).not.toHaveProperty('modelName')
  })
  it('shows provider-dark current-source evidence without starting a run', async () => {
    renderPanel(false)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Check current source coverage' }))

    expect(await screen.findByText(/1\/2 lexical markers found/)).toBeTruthy()
    expect(screen.getByText(/Not found: location/)).toBeTruthy()
    expect(mocks.sourceCoverage).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      caseIds: [item.id],
    })
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
  it('targets the exact reviewable package when onboarding evidence is supplied', async () => {
    render(
      <EvaluationRunRequestPanel
        tenantId="tenant-1"
        venueId="venue-1"
        initialCases={[item]}
        initialNextCursor={null}
        runnerEnabled
        maximumCases={50}
        reviewablePackages={[
          {
            id: 'package_1',
            status: 'DRAFT',
            payloadHash: 'a'.repeat(64),
            baseDigest: 'b'.repeat(64),
            createdAt: new Date(),
            approvedAt: null,
            supportHandoffs: [],
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      reviewablePackageId: 'package_1',
      caseIds: [item.id],
    })
  })
  it('selects only the latest seven case revisions tied to the chosen package hash', async () => {
    const payloadHash = 'a'.repeat(64)
    const baseDigest = 'b'.repeat(64)
    const sourceRef = `venue-package-review:package_1:${payloadHash}:${baseDigest}`
    const dimensions = [
      'fact',
      'navigation',
      'accessibility',
      'safety',
      'multilingual',
      'adversarial',
      'unanswerable',
    ]
    const onboardingCases = dimensions.flatMap((dimension, index) => [
      {
        ...item,
        id: `00000000-0000-4000-8000-${(index * 2).toString().padStart(12, '0')}`,
        caseKey: `onboarding-${dimension}-reviewable-package`,
        revision: 1,
        sourceType: 'ONBOARDING_REVIEWABLE_PACKAGE',
        sourceRef,
      },
      {
        ...item,
        id: `00000000-0000-4000-8000-${(index * 2 + 1).toString().padStart(12, '0')}`,
        caseKey: `onboarding-${dimension}-reviewable-package`,
        revision: 2,
        sourceType: 'ONBOARDING_REVIEWABLE_PACKAGE',
        sourceRef,
      },
    ])
    render(
      <EvaluationRunRequestPanel
        tenantId="tenant-1"
        venueId="venue-1"
        initialCases={onboardingCases}
        initialNextCursor={null}
        runnerEnabled
        maximumCases={50}
        reviewablePackages={[
          {
            id: 'package_1',
            status: 'DRAFT',
            payloadHash,
            baseDigest,
            createdAt: new Date(),
            approvedAt: null,
            supportHandoffs: [],
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Select seven onboarding cases' }))
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate.mock.calls[0]?.[0].caseIds).toEqual(
      onboardingCases
        .filter((candidate) => candidate.revision === 2)
        .map((candidate) => candidate.id),
    )
  })
  it('selects exactly the paired ten-language suite tied to the chosen package hash', async () => {
    const payloadHash = 'a'.repeat(64)
    const baseDigest = 'b'.repeat(64)
    const sourceRef = `venue-package-review:package_1:${payloadHash}:${baseDigest}`
    const languages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar']
    const languageCases = languages.flatMap((language, languageIndex) =>
      ['grounded', 'fallback'].map((kind, kindIndex) => ({
        ...item,
        id: `00000000-0000-4000-8000-${(languageIndex * 2 + kindIndex).toString().padStart(12, '0')}`,
        caseKey: `onboarding-language-${language}-${kind}`,
        revision: 1,
        sourceType: 'ONBOARDING_REVIEWABLE_PACKAGE',
        sourceRef,
      })),
    )
    render(
      <EvaluationRunRequestPanel
        tenantId="tenant-1"
        venueId="venue-1"
        initialCases={languageCases}
        initialNextCursor={null}
        runnerEnabled
        maximumCases={50}
        reviewablePackages={[
          {
            id: 'package_1',
            status: 'DRAFT',
            payloadHash,
            baseDigest,
            createdAt: new Date(),
            approvedAt: null,
            supportHandoffs: [],
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Select 20 launch-language cases' }))
    expect(screen.getByText('Cases (20/50)')).toBeTruthy()
    expect((screen.getByLabelText('Budget ceiling') as HTMLInputElement).value).toBe('4.0512')
    expect(screen.getByText(/Conservative full-run ceiling.*\$4\.0512/)).toBeTruthy()
    expect(screen.getByText(/0 of 7 exact-package cases are ready/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      caseIds: languageCases.map((candidate) => candidate.id),
      reviewablePackageId: 'package_1',
    })
  })
  it('serializes double submission', async () => {
    let resolve!: (value: { enqueued: boolean }) => void
    mocks.mutate.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    renderPanel()
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: 'Request run' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    resolve({ enqueued: true })
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
  })
  it('preserves selection and reports an ambiguous mutation outcome', async () => {
    mocks.mutate.mockRejectedValue(new Error('network lost'))
    renderPanel()
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    expect(await screen.findByText(/outcome is unknown/i)).toBeTruthy()
    expect((checkbox as HTMLInputElement).checked).toBe(true)
  })
  it('states confirmed queueing honestly when evidence refresh fails', async () => {
    mocks.listRuns.mockRejectedValue(new Error('refresh failed'))
    renderPanel()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    expect(await screen.findByText(/queueing was confirmed/i)).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
  it('reports durable staging without claiming direct queue publication', async () => {
    mocks.mutate.mockResolvedValue({ enqueued: false, dispatchPending: true, status: 'STAGED' })
    renderPanel()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    expect(await screen.findByText(/Run staged/i)).toBeTruthy()
    expect(screen.getByText(/durable worker dispatcher/i)).toBeTruthy()
    expect(mocks.listRuns).not.toHaveBeenCalled()
  })
  it('converts bounded decimal USD without floating point', () => {
    expect(evaluationBudgetToE8Usd('1')).toBe('100000000')
    expect(evaluationBudgetToE8Usd('0.00000001')).toBe('1')
    expect(evaluationBudgetToE8Usd('4.1')).toBe('410000000')
    expect(evaluationBudgetToE8Usd('4.10000001')).toBeNull()
    expect(evaluationBudgetFromE8Usd(102_048_000n)).toBe('1.02048')
  })

  it('refuses a run whose ceiling cannot conservatively reserve every selected case', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Budget ceiling'), { target: { value: '0.20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    expect(await screen.findByText(/needs a conservative \$0\.20256 ceiling/)).toBeTruthy()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('resets scope and ignores a late request response from the prior venue', async () => {
    let resolve!: (value: { enqueued: boolean }) => void
    mocks.mutate.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    const view = renderPanel()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Request run' }))
    view.rerender(
      <EvaluationRunRequestPanel
        tenantId="tenant-2"
        venueId="venue-2"
        initialCases={[]}
        initialNextCursor={null}
        runnerEnabled
        maximumCases={50}
      />,
    )
    expect(await screen.findByText(/No evaluation cases are ready/)).toBeTruthy()
    resolve({ enqueued: true })
    await Promise.resolve()
    expect(mocks.listRuns).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
