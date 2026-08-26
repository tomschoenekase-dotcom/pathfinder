import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocationBanner } from './LocationBanner'

describe('LocationBanner', () => {
  afterEach(cleanup)

  it.each([
    ['loading', /still ask general questions/i],
    ['denied', /General questions still work/i],
    ['prompt', /General questions work without it/i],
  ] as const)('keeps knowledge chat available while permission is %s', (permission, message) => {
    render(<LocationBanner permission={permission} onRefresh={vi.fn()} />)

    expect(screen.getByText(message)).toBeTruthy()
  })

  it('offers a retry action after denial', () => {
    const onRefresh = vi.fn()
    render(<LocationBanner permission="denied" onRefresh={onRefresh} />)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('uses the selected language and direction for location consent', () => {
    render(<LocationBanner permission="prompt" onRefresh={vi.fn()} language="العربية" />)

    const action = screen.getByRole('button', { name: 'مشاركة الموقع' })
    expect(action).toBeTruthy()
    expect(action.closest('section')?.getAttribute('lang')).toBe('ar')
    expect(action.closest('section')?.getAttribute('dir')).toBe('rtl')
  })

  it.each([
    { permission: 'granted' as const, show: true },
    { permission: 'prompt' as const, show: false },
  ])('stays hidden for $permission with show=$show', ({ permission, show }) => {
    const { container } = render(
      <LocationBanner permission={permission} onRefresh={vi.fn()} show={show} />,
    )

    expect(container.innerHTML).toBe('')
  })
})
