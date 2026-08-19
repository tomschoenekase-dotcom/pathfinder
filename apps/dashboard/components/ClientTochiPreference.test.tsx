/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClientTochiPreference } from './ClientTochiPreference'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(() => cleanup())

describe('ClientTochiPreference', () => {
  it('saves the optional on/off preference without implying other portal features change', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    render(<ClientTochiPreference initialEnabled available onChange={onChange} />)

    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/never removes normal navigation/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))

    expect(await screen.findByText('Tochi assistance is off.')).toBeTruthy()
    expect(onChange).toHaveBeenCalledWith(false)
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('fails closed when rollout is unavailable', () => {
    const onChange = vi.fn()
    render(<ClientTochiPreference initialEnabled={false} available={false} onChange={onChange} />)

    expect(screen.getByText(/not enabled for your organization yet/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'On' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the last confirmed value when persistence fails', async () => {
    render(
      <ClientTochiPreference
        initialEnabled
        available
        onChange={vi.fn().mockRejectedValue(new Error('offline'))}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    expect(await screen.findByText(/preference was not saved/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true')
  })
})
