import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import jsQR from 'jsqr'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { VenueQrKit } from './VenueQrKit'

const guestChatUrl = 'https://guide.example.com/museum/chat'
const attributedGuestChatUrl = `${guestChatUrl}?source=qr`

function renderGeneralQrSvg() {
  const markup = renderToStaticMarkup(
    <VenueQrKit
      venueName="Museum"
      guestChatUrl={guestChatUrl}
      generatedAt="2026-08-28T00:00:00.000Z"
      guideItems={[]}
    />,
  )
  const svg = markup.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/)?.[0]

  expect(svg).toBeTruthy()
  return svg as string
}

async function rasterizeQr(svg: string, options: { damageSize?: number; rotation?: number } = {}) {
  const size = 832
  let pipeline = sharp(Buffer.from(svg)).resize(size, size, { kernel: sharp.kernel.nearest })

  if (options.damageSize) {
    const damage = options.damageSize
    pipeline = pipeline.composite([
      {
        input: {
          create: {
            width: damage,
            height: damage,
            channels: 4,
            background: '#ffffff',
          },
        },
        left: Math.floor((size - damage) / 2),
        top: Math.floor((size - damage) / 2),
      },
    ])
  }

  if (options.rotation) {
    pipeline = pipeline.rotate(options.rotation, { background: '#ffffff' })
  }

  return pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

async function decodeQr(svg: string, options?: { damageSize?: number; rotation?: number }) {
  const { data, info } = await rasterizeQr(svg, options)
  return jsQR(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
    { inversionAttempts: 'attemptBoth' },
  )?.data
}

describe('VenueQrKit image decoding resilience', () => {
  it.each([0, 90, 180, 270])('decodes the exact public URL at %i degrees', async (rotation) => {
    const svg = renderGeneralQrSvg()

    await expect(decodeQr(svg, { rotation })).resolves.toBe(attributedGuestChatUrl)
  })

  it('recovers the exact public URL through bounded center damage', async () => {
    const svg = renderGeneralQrSvg()

    await expect(decodeQr(svg, { damageSize: 72 })).resolves.toBe(attributedGuestChatUrl)
  })

  it('fails closed when damage exceeds the decoder recovery bound', async () => {
    const svg = renderGeneralQrSvg()

    await expect(decodeQr(svg, { damageSize: 360 })).resolves.toBeUndefined()
  })
})
