import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  venueList: vi.fn(),
  uploadList: vi.fn(),
  proposalList: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('../../../components/IntakeFileUpload', () => ({
  IntakeFileUploadWorkspace: () => <div>File intake</div>,
}))
vi.mock('../../../components/IntakeProposalWorkspace', () => ({
  IntakeProposalWorkspace: () => <div>Proposal intake</div>,
}))
vi.mock('../../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    venue: { list: mocks.venueList },
    intakeUpload: { list: mocks.uploadList },
    intake: { listProposals: mocks.proposalList },
  })),
}))

import InformationPage from './page'

describe('InformationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venueList.mockResolvedValue([{ id: 'venue_alpha', name: 'Science Museum' }])
    mocks.uploadList.mockResolvedValue({ items: [], nextCursor: null })
    mocks.proposalList.mockResolvedValue([])
  })

  it('keeps every optional source path visible without an expansion control', async () => {
    const element = await InformationPage({ searchParams: Promise.resolve({}) })
    const html = renderToStaticMarkup(element)

    expect(html).toContain('Add a website, staff knowledge, or optional notes')
    expect(html).toContain('Proposal intake')
    expect(html).not.toContain('<details')
    expect(html).not.toContain('<summary')
  })
})
