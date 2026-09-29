import { describe, expect, it, vi } from 'vitest'

import { createHostPlaceAction } from './HostPlaceAction'

const place = { id: 'place-1', name: 'Sky Deck' }

describe('createHostPlaceAction', () => {
  it('exists only for an opted-in public app door', () => {
    const base = { label: 'Open in app', secondLayer: false, post: vi.fn(), track: vi.fn() }
    expect(createHostPlaceAction({ ...base, presentation: 'webview' })?.label).toBe('Open in app')
    for (const presentation of ['standalone', 'embed', 'embed-inline'] as const)
      expect(createHostPlaceAction({ ...base, presentation })).toBeNull()
    expect(createHostPlaceAction({ ...base, presentation: 'webview', label: undefined })).toBeNull()
    expect(
      createHostPlaceAction({ ...base, presentation: 'webview', secondLayer: true }),
    ).toBeNull()
  })

  it('counts a tap only after a native channel received it', () => {
    const track = vi.fn()
    const post = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const action = createHostPlaceAction({
      presentation: 'webview',
      label: 'Open in app',
      secondLayer: false,
      post,
      track,
    })!
    action.onAction(place)
    expect(track).not.toHaveBeenCalled()
    action.onAction(place)
    expect(post).toHaveBeenLastCalledWith(place)
    expect(track).toHaveBeenCalledExactlyOnceWith('place-1')
  })
})
