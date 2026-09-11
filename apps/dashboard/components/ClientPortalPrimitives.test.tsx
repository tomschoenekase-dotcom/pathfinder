/* @vitest-environment jsdom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ClientJourneyRail, PortalPrimaryAction, TorchikoCore } from './ClientPortalPrimitives'

afterEach(cleanup)

describe('client portal primitives', () => {
  it('exposes journey position semantically without relying on marker color', () => {
    render(
      <ClientJourneyRail
        stages={[
          { id: 'welcome', label: 'Welcome', status: 'complete' },
          { id: 'share', label: 'Share', status: 'current' },
          { id: 'processing', label: 'Processing', status: 'upcoming' },
          { id: 'questions', label: 'Questions', status: 'upcoming' },
          { id: 'ready', label: 'Ready', status: 'upcoming' },
        ]}
      />,
    )

    const rail = screen.getByRole('region', { name: 'Onboarding progress' })
    expect(within(rail).getAllByRole('listitem')).toHaveLength(5)
    expect(within(rail).getByText('Complete')).toBeTruthy()
    expect(within(rail).getByText('Current')).toBeTruthy()
    expect(rail.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
    expect(rail.querySelector('[aria-current="step"]')?.textContent).toContain('Share')
  })

  it.each(['welcome', 'share', 'processing', 'questions', 'ready', 'live'] as const)(
    'keeps the neutral %s fallback decorative while exposing state to layout hooks',
    (state) => {
      const { container } = render(<TorchikoCore state={state} />)
      const core = container.firstElementChild

      expect(core?.getAttribute('data-state')).toBe(state)
      expect(core?.querySelector('[aria-hidden="true"]')?.textContent).toBe('Torchiko')
      expect(core?.querySelector('svg')).toBeNull()
      expect(core?.querySelector('path')).toBeNull()
      expect(screen.queryByRole('img')).toBeNull()
    },
  )

  it('provides one primary heading and plain navigation actions around the visual', () => {
    render(
      <PortalPrimaryAction
        headingId="portal-action"
        eyebrow="Torchiko for Museum"
        title="Share what you already have"
        summary="We will organize it."
        primaryAction={{ href: '#materials', label: 'Share materials' }}
        secondaryAction={{ href: '/support', label: 'Ask for help' }}
        state="share"
      />,
    )

    expect(
      screen.getByRole('heading', { level: 1, name: 'Share what you already have' }),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Share materials' }).getAttribute('href')).toBe(
      '#materials',
    )
    expect(screen.getByRole('link', { name: 'Ask for help' }).getAttribute('href')).toBe('/support')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('keeps signature motion optional and all five stages in the mobile flow', () => {
    const primitiveCss = readFileSync(
      resolve(process.cwd(), 'components/TorchikoClientPrimitives.module.css'),
      'utf8',
    )
    const uploadCss = readFileSync(
      resolve(process.cwd(), 'components/IntakeFileUpload.module.css'),
      'utf8',
    )
    const mobileStart = primitiveCss.indexOf('@media (max-width: 760px)')
    const reducedStart = primitiveCss.indexOf('@media (prefers-reduced-motion: reduce)')
    const mobileCss = primitiveCss.slice(mobileStart, reducedStart)
    const reducedCss = primitiveCss.slice(reducedStart)
    const reducedUploadCss = uploadCss.slice(
      uploadCss.indexOf('@media (prefers-reduced-motion: reduce)'),
    )

    expect(mobileStart).toBeGreaterThan(-1)
    expect(reducedStart).toBeGreaterThan(mobileStart)
    expect(mobileCss).toMatch(/\.journey\s*\{[\s\S]*?overflow:\s*visible;/u)
    expect(mobileCss).toMatch(/\.journeyList\s*\{[\s\S]*?width:\s*100%;/u)
    expect(primitiveCss).toMatch(
      /\.journeyList\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\);/u,
    )
    expect(reducedCss).toMatch(/\.primaryLink,[\s\S]*?\.secondaryLink[\s\S]*?transition:\s*none;/u)
    expect(reducedUploadCss).toMatch(
      /\.dropField,[\s\S]*?\.progressTrack span[\s\S]*?transition:\s*none;/u,
    )
    expect(reducedUploadCss).toMatch(
      /\.dropField\[data-activity\]::after,[\s\S]*?\.spinning[\s\S]*?animation:\s*none;/u,
    )
    expect(uploadCss).toMatch(/\.fileCategory select\s*\{[\s\S]*?min-height:\s*2\.75rem;/u)
  })
})
