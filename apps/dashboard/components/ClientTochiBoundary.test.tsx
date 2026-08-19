/* @vitest-environment jsdom */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { ClientTochiBoundary } from './ClientTochiBoundary'

function BrokenAssistant(): never {
  throw new Error('character renderer failed')
}

describe('ClientTochiBoundary', () => {
  it('removes only optional assistance when its subtree fails', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <main>
        <p>Normal portal action</p>
        <ClientTochiBoundary>
          <BrokenAssistant />
        </ClientTochiBoundary>
      </main>,
    )
    expect(screen.getByText('Normal portal action')).toBeTruthy()
    expect(screen.queryByText('Broken assistant')).toBeNull()
    consoleError.mockRestore()
  })
})
