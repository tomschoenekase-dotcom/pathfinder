import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('@pathfinder/ui/brand', () => ({ TorchikoIcon: () => <span>Icon</span> }))

import { VenueChatError, VenueChatSkeleton } from './VenueChatStates'
import { VenueTemporarilyUnavailable } from './VenueTemporarilyUnavailable'

describe('localized venue chat states', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the loading state in Arabic with RTL semantics', () => {
    render(<VenueChatSkeleton language="العربية" />)

    const status = screen.getByRole('status')
    expect(status.getAttribute('lang')).toBe('ar')
    expect(status.getAttribute('dir')).toBe('rtl')
    expect(screen.getByText('جارٍ تحميل دليلك…')).toBeTruthy()
  })

  it('localizes an Arabic lookup error without rewriting its safe server detail', () => {
    render(
      <VenueChatError
        language="العربية"
        message="Reference ABC is not active."
        presentation="standalone"
      />,
    )

    const heading = screen.getByRole('heading', { name: 'المكان غير متاح' })
    expect(heading.closest('main')?.getAttribute('dir')).toBe('rtl')
    expect(screen.getByText('Reference ABC is not active.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'حاول مرة أخرى' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'العودة إلى الصفحة الرئيسية' })).toBeTruthy()
  })

  it('localizes the Arabic temporary state and keeps retry operational', () => {
    render(<VenueTemporarilyUnavailable language="العربية" />)

    expect(screen.getByRole('heading', { name: 'الدليل غير متاح مؤقتًا' })).toBeTruthy()
    expect(screen.getByText('دليل هذا المكان غير متاح مؤقتًا. حاول مرة أخرى لاحقًا.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'حاول مرة أخرى' }))
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
