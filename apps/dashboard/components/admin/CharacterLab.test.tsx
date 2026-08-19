// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CharacterAssetManifestSchema,
  CharacterDefinitionSchema,
} from '@pathfinder/contracts/character-system'

import definitionData from '../../../../assets/characters/tochi/definition.json'
import manifestData from '../../../../assets/characters/tochi/v0-development/manifest.json'
import { CharacterLab } from './CharacterLab'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
afterEach(() => cleanup())

describe('CharacterLab', () => {
  it('exposes all semantic states and keeps development art visibly non-publishable', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    render(
      <CharacterLab
        definition={CharacterDefinitionSchema.parse(definitionData)}
        manifest={CharacterAssetManifestSchema.parse(manifestData)}
        initial={{
          state: 'idle',
          context: 'client-assistant',
          motion: 'system',
          background: 'mist',
          viewport: 'desktop',
          size: 'stage',
          intensity: 0.6,
          lookAtX: 0,
          lookAtY: 0,
        }}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Character Lab' })).toBeTruthy()
    expect(screen.getByText('Temporary development assets')).toBeTruthy()
    expect(screen.getByText('Publishable').nextElementSibling?.textContent).toBe('No')
    expect(screen.getByRole('button', { name: 'Upload Receiving' })).toBeTruthy()
    expect(screen.getAllByRole('button', { pressed: false }).length).toBeGreaterThanOrEqual(14)

    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getByRole('button', { name: 'Thinking' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(replaceState).toHaveBeenCalled()
  })

  it('exposes deterministic reduced-motion and asset-failure controls', () => {
    render(
      <CharacterLab
        definition={CharacterDefinitionSchema.parse(definitionData)}
        manifest={CharacterAssetManifestSchema.parse(manifestData)}
        initial={{
          state: 'idle',
          context: 'venue-text-chat',
          motion: 'reduced',
          background: 'ink',
          viewport: 'mobile',
          size: 'compact',
          intensity: 0.25,
          lookAtX: -0.5,
          lookAtY: 0.5,
        }}
      />,
    )

    expect((screen.getByRole('combobox', { name: /Motion/ }) as HTMLSelectElement).value).toBe(
      'reduced',
    )
    expect(
      (screen.getByRole('combobox', { name: /Presentation/ }) as HTMLSelectElement).value,
    ).toBe('compact')
    const failure = screen.getByRole('button', { name: 'Simulate asset failure' })
    fireEvent.click(failure)
    expect(screen.getByRole('button', { name: 'Restore verified assets' })).toBeTruthy()
    expect(screen.getByText('On')).toBeTruthy()
  })

  it('switches between compact text-chat and future voice-stage compositions', () => {
    render(
      <CharacterLab
        definition={CharacterDefinitionSchema.parse(definitionData)}
        manifest={CharacterAssetManifestSchema.parse(manifestData)}
        initial={{
          state: 'attention',
          context: 'venue-text-chat',
          motion: 'system',
          background: 'mist',
          viewport: 'mobile',
          size: 'compact',
          intensity: 0.6,
          lookAtX: 0,
          lookAtY: 0,
        }}
      />,
    )

    const presentation = screen.getByRole('combobox', {
      name: /Presentation/,
    }) as HTMLSelectElement
    expect(document.querySelector('[data-character-presentation="compact"]')).toBeTruthy()
    fireEvent.change(presentation, { target: { value: 'stage' } })
    expect(document.querySelector('[data-character-presentation="stage"]')).toBeTruthy()
  })
})
