import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  WIDGET_READY_MESSAGE_TYPE,
  WIDGET_READY_MESSAGE_VERSION,
  WidgetReadySignal,
} from './WidgetReadySignal'

describe('WidgetReadySignal', () => {
  const originalParent = window.parent

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent })
  })

  it('sends one fixed non-sensitive readiness payload only to a framing parent', () => {
    const parent = { postMessage: vi.fn() }
    Object.defineProperty(window, 'parent', { configurable: true, value: parent })

    const view = render(<WidgetReadySignal venueSlug="museum" />)
    view.rerender(<WidgetReadySignal venueSlug="museum" />)

    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    expect(parent.postMessage).toHaveBeenCalledWith(
      {
        type: WIDGET_READY_MESSAGE_TYPE,
        version: WIDGET_READY_MESSAGE_VERSION,
        venueSlug: 'museum',
      },
      '*',
    )
  })

  it('does not emit when the page is top-level', () => {
    const postMessage = vi.spyOn(window, 'postMessage')

    render(<WidgetReadySignal venueSlug="museum" />)

    expect(postMessage).not.toHaveBeenCalled()
    postMessage.mockRestore()
  })
})
