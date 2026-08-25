/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AnswerAttributionAgreementCard } from './AnswerAttributionAgreementCard'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const data = {
  reportHash: 'a'.repeat(64),
  invalidRecordCount: 0,
  truncated: false,
  report: {
    inputRecordCount: 2,
    selectedRecordCount: 2,
    turnCount: 1,
    comparableGroupCount: 1,
    independentPairCount: 1,
    distinctReviewerCount: 2,
    exclusions: {
      repeatedReviewerRecordCount: 0,
      singleReviewerGroupCount: 0,
      identityConflictTurnCount: 0,
    },
    metrics: {
      coverageOverlapRate: 0.75,
      supportAgreementRate: 0.5,
      sourceAgreementRate: 1,
    },
  },
}

describe('AnswerAttributionAgreementCard', () => {
  afterEach(cleanup)

  it('renders descriptive reviewer agreement without a pass or release verdict', () => {
    render(<AnswerAttributionAgreementCard data={data} />)

    expect(screen.getByText('Claim-review agreement')).toBeTruthy()
    expect(screen.getByText('75%')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()
    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.getByText(/do not prove correctness/)).toBeTruthy()
    expect(screen.queryByText(/^Pass$/i)).toBeNull()
  })

  it('shows the honest two-reviewer empty state', () => {
    render(
      <AnswerAttributionAgreementCard
        data={{
          ...data,
          report: {
            ...data.report,
            comparableGroupCount: 0,
            independentPairCount: 0,
            metrics: {
              coverageOverlapRate: null,
              supportAgreementRate: null,
              sourceAgreementRate: null,
            },
          },
        }}
      />,
    )

    expect(screen.getByText('Calibration is not yet comparable')).toBeTruthy()
    expect(screen.getByText(/At least two different human reviewers/)).toBeTruthy()
  })

  it('fails visibly when calibration cannot be loaded', () => {
    render(<AnswerAttributionAgreementCard data={null} />)
    expect(screen.getByRole('status').textContent).toContain('Claim-review calibration unavailable')
  })
})
