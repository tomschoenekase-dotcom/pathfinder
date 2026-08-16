/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@pathfinder/ui', () => ({ TorchicoBrand: () => <div>Torchico</div> }))

import PrivacyPage, { metadata } from './page'

describe('privacy notice', () => {
  afterEach(cleanup)

  it('provides an honest staging notice and a working route home', () => {
    render(<PrivacyPage />)

    expect(metadata.title).toBe('Privacy notice — Torchico')
    expect(screen.getByRole('heading', { name: 'Use staging safely' })).toBeTruthy()
    expect(
      screen.getByText(/reviewed production privacy policy has not yet been published/u),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to Torchico' }).getAttribute('href')).toBe('/')
    expect(screen.getByRole('link', { name: /tomschoenekase@gmail.com/u })).toBeTruthy()
  })
})
