/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
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
            verificationOperation: 'NOT_APPLICABLE',
            operatorActionRequired: false,
            createdAt: new Date('2026-08-11T15:00:00Z'),
          },
        ]}
      />,
    )
    expect(screen.getByText('Visitor map')).toBeTruthy()
    expect(screen.getByText('Checks complete — awaiting review')).toBeTruthy()
    expect(screen.getByText(/not a guarantee that a file is malware-free/i)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('has a graceful empty state', () => {
    render(<IntakeUploadReviewList uploads={[]} />)
    expect(screen.getByText('No quarantined file submissions.')).toBeTruthy()
  })

  it('uses allowlisted pending and rejection copy without rendering raw status or reason codes', () => {
    render(
      <IntakeUploadReviewList
        uploads={[
          {
            id: 'upload-pending',
            status: 'PRECHECK_PASSED',
            displayName: 'Pending map',
            fileName: 'pending.pdf',
            mimeType: 'application/pdf',
            byteSize: 1024,
            rejectionCode: null,
            intakeRunId: null,
            verificationOperation: 'QUEUED',
            operatorActionRequired: false,
            createdAt: new Date('2026-08-11T15:00:00Z'),
          },
          {
            id: 'upload-rejected',
            status: 'INTERNAL_SCANNER_STATE',
            displayName: 'Rejected map',
            fileName: 'rejected.pdf',
            mimeType: 'application/pdf',
            byteSize: 1024,
            rejectionCode: 'engine-signature=/private/scanner/path',
            intakeRunId: null,
            verificationOperation: 'NOT_APPLICABLE',
            operatorActionRequired: false,
            createdAt: new Date('2026-08-11T15:00:00Z'),
          },
        ]}
      />,
    )

    expect(screen.getByText('Security check pending')).toBeTruthy()
    expect(screen.getByText('Authoritative security verification is queued.')).toBeTruthy()
    expect(screen.getByText('Status unavailable')).toBeTruthy()
    expect(screen.getByText('The file could not be accepted.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /INTERNAL_SCANNER_STATE|engine-signature|private\/scanner/iu,
    )
  })

  it('has no automated accessibility violations for pending and rejected checks', async () => {
    const { container } = render(
      <IntakeUploadReviewList
        uploads={[
          {
            id: 'upload-pending',
            status: 'PRECHECK_PASSED',
            displayName: 'Pending map',
            fileName: 'pending.pdf',
            mimeType: 'application/pdf',
            byteSize: 1024,
            rejectionCode: null,
            intakeRunId: null,
            verificationOperation: 'QUEUED',
            operatorActionRequired: false,
            createdAt: new Date('2026-08-11T15:00:00Z'),
          },
          {
            id: 'upload-rejected',
            status: 'REJECTED',
            displayName: 'Rejected map',
            fileName: 'rejected.pdf',
            mimeType: 'application/pdf',
            byteSize: 1024,
            rejectionCode: 'UNSAFE_FILE',
            intakeRunId: null,
            verificationOperation: 'NOT_APPLICABLE',
            operatorActionRequired: false,
            createdAt: new Date('2026-08-11T15:00:00Z'),
          },
        ]}
      />,
    )
    document.documentElement.lang = 'en'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations).toEqual([])
  })
})
