/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { IntakeUploadReviewList } from './IntakeUploadReviewList'

afterEach(cleanup)

describe('admin intake upload review list', () => {
  it('renders safe lifecycle metadata and no file access or governance controls', () => {
    render(
      <IntakeUploadReviewList
        uploads={[
          {
            id: 'upload-a',
            status: 'AWAITING_REVIEW',
            displayName: 'Visitor map',
            fileName: 'map.pdf',
            mimeType: 'application/pdf',
            byteSize: 1024,
            rejectionCode: null,
            intakeRunId: 'run-a',
            createdAt: new Date('2026-08-11T15:00:00Z'),
          },
        ]}
      />,
    )
    expect(screen.getByText('Visitor map')).toBeTruthy()
    expect(screen.getByText('AWAITING REVIEW')).toBeTruthy()
    expect(screen.getByText(/does not confirm format validity or malware inspection/i)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('has a graceful empty state', () => {
    render(<IntakeUploadReviewList uploads={[]} />)
    expect(screen.getByText('No quarantined file submissions.')).toBeTruthy()
  })
})
