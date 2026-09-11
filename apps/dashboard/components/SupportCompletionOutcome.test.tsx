/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SupportCompletionOutcome } from './SupportCompletionOutcome'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('SupportCompletionOutcome', () => {
  afterEach(cleanup)

  it.each([
    ['UPDATED', 'Updates applied'],
    ['NO_CHANGE', 'No change needed'],
    ['MIXED', 'Updates and reviewed items'],
    ['RESOLVED', 'Request resolved'],
  ] as const)('renders %s as a factual outcome', (outcome, label) => {
    render(<SupportCompletionOutcome outcome={outcome} />)
    expect(screen.getByText(label)).toBeTruthy()
  })
})
