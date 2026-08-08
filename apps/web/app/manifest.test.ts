import { describe, expect, it } from 'vitest'

import manifest from './manifest'

describe('web app manifest', () => {
  it('exposes the installable PathFinder contract from the Metadata API route', () => {
    expect(manifest()).toEqual({
      name: 'PathFinder',
      short_name: 'PathFinder',
      description: 'Your venue guide',
      start_url: '/',
      display: 'standalone',
      background_color: '#0f172a',
      theme_color: '#0f172a',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    })
  })
})
