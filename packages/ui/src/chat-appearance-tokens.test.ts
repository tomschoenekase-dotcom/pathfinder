import { describe, expect, it } from 'vitest'

import {
  CHAT_TEXT_CONTRAST_MINIMUM,
  chatContrastRatio,
  getChatPalette,
  resolveChatAppearance,
  type ChatAppearanceInput,
} from './theme'

const plain: ChatAppearanceInput = {
  userBubble: true,
  assistantBubble: false,
  userTextColor: null,
  assistantTextColor: null,
  userBubbleColor: null,
  assistantSurfaceColor: null,
  headerTitleColor: null,
  headerColor: null,
  footerColor: null,
  background: { mode: 'none', focalX: 50, focalY: 50, dim: 45 },
}

function readablePairs(tokens: ReturnType<typeof resolveChatAppearance>) {
  return [
    ['header title', tokens.headerText, tokens.headerBg],
    ['header muted', tokens.headerMuted, tokens.headerBg],
    ['bottom bar', tokens.footerText, tokens.footerBg],
    ['bottom bar muted', tokens.footerMuted, tokens.footerBg],
    ['composer', tokens.fieldText, tokens.fieldBg],
    ['composer placeholder', tokens.fieldMuted, tokens.fieldBg],
    ['visitor text', tokens.userText, tokens.userBg],
    ['guide text', tokens.assistantText, tokens.assistantBg],
    ['follow-up action', tokens.actionText, tokens.actionBg],
  ] as const
}

describe('resolveChatAppearance', () => {
  it('matches the reference default: tinted visitor bubble, open answer, no image', () => {
    const palette = getChatPalette('default', null)
    const tokens = resolveChatAppearance(palette, plain)
    expect(tokens.userSurface).toBe(true)
    expect(tokens.userBg).not.toBe(palette.accent)
    expect(tokens.userText).toBe(palette.text)
    expect(tokens.assistantBubble).toBe(false)
    expect(tokens.assistantProtected).toBe(false)
    expect(tokens.assistantBg).toBe(palette.bg)
    expect(tokens.headerBg).toBe(palette.card)
    expect(tokens.footerBg).toBe(palette.bg)
    expect(tokens.speakerLabels).toBe(false)
    expect(tokens.backgroundImage).toBe(false)
    expect(tokens.corrections).toEqual([])
  })

  it('corrects and reports an unreadable venue text colour', () => {
    const palette = getChatPalette('default', null)
    const tokens = resolveChatAppearance(palette, {
      ...plain,
      assistantBubble: true,
      assistantSurfaceColor: '#FFFFFF',
      assistantTextColor: '#EEEEEE',
    })
    expect(tokens.assistantText).not.toBe('#EEEEEE')
    expect(chatContrastRatio(tokens.assistantText, tokens.assistantBg)).toBeGreaterThanOrEqual(4.5)
    expect(tokens.corrections).toEqual([
      expect.objectContaining({ field: 'assistantTextColor', requested: '#EEEEEE' }),
    ])
  })

  it('never leaves text directly on an image: both speakers get a reading surface', () => {
    const palette = getChatPalette('dark', '#3A7BD5')
    const tokens = resolveChatAppearance(
      palette,
      {
        ...plain,
        userBubble: false,
        background: { mode: 'image', focalX: 20, focalY: 80, dim: 30 },
      },
      { hasBackgroundImage: true },
    )
    expect(tokens.backgroundImage).toBe(true)
    expect(tokens.assistantProtected).toBe(true)
    expect(tokens.userSurface).toBe(true)
    expect(tokens.assistantBg).toBe(palette.card)
    expect(tokens.backgroundPosition).toBe('20% 80%')
    expect(tokens.backgroundOverlay).toBe('rgb(0 0 0 / 0.3)')
  })

  it('falls back to the plain surface when the image is not available', () => {
    const palette = getChatPalette('default', null)
    const tokens = resolveChatAppearance(palette, {
      ...plain,
      background: { mode: 'image', focalX: 50, focalY: 50, dim: 45 },
    })
    expect(tokens.backgroundImage).toBe(false)
    expect(tokens.assistantProtected).toBe(false)
  })

  it('shows speaker labels only when both bubbles are off', () => {
    const palette = getChatPalette('forest', null)
    expect(resolveChatAppearance(palette, plain).speakerLabels).toBe(false)
    expect(
      resolveChatAppearance(palette, { ...plain, userBubble: false, assistantBubble: true })
        .speakerLabels,
    ).toBe(false)
    expect(
      resolveChatAppearance(palette, { ...plain, userBubble: false, assistantBubble: false })
        .speakerLabels,
    ).toBe(true)
  })

  it('links the bottom bar to a coloured header unless the venue unlinks it', () => {
    const palette = getChatPalette('default', null)
    expect(resolveChatAppearance(palette, { ...plain, headerColor: '#0B1426' }).footerBg).toBe(
      '#0B1426',
    )
    expect(
      resolveChatAppearance(palette, { ...plain, headerColor: '#0B1426', footerColor: '#FFFFFF' })
        .footerBg,
    ).toBe('#FFFFFF')
  })

  it('uses stark surfaces and hides images for the visitor high-contrast preference', () => {
    const palette = getChatPalette('sunset', null)
    const tokens = resolveChatAppearance(
      palette,
      {
        ...plain,
        headerColor: '#123456',
        background: { mode: 'image', focalX: 0, focalY: 0, dim: 0 },
      },
      { hasBackgroundImage: true, highContrast: true },
    )
    expect(tokens.backgroundImage).toBe(false)
    expect(tokens.pageBg).toBe('#FFFFFF')
    expect(tokens.pageText).toBe('#000000')
    expect(chatContrastRatio(tokens.actionText, tokens.actionBg)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps every text and surface pair readable across themes, colours and layouts', () => {
    const colours = [
      null,
      '#FFFFFF',
      '#000000',
      '#FFFF00',
      '#3A7BD5',
      '#777777',
      '#0B1426',
      '#F2F5F9',
    ]
    const failures: string[] = []
    for (const theme of ['default', 'forest', 'sunset', 'midnight', 'rose', 'dark']) {
      for (const accent of [null, '#FFFF00', '#1A1A1A']) {
        const palette = getChatPalette(theme, accent)
        for (const [index, colour] of colours.entries()) {
          const other = colours[(index + 3) % colours.length] ?? null
          for (const userBubble of [true, false]) {
            for (const assistantBubble of [true, false]) {
              for (const image of [true, false]) {
                for (const highContrast of [false, true]) {
                  const tokens = resolveChatAppearance(
                    palette,
                    {
                      userBubble,
                      assistantBubble,
                      userTextColor: colour,
                      assistantTextColor: other,
                      userBubbleColor: other,
                      assistantSurfaceColor: colour,
                      headerTitleColor: colour,
                      headerColor: other,
                      footerColor: colour,
                      background: {
                        mode: image ? 'image' : 'none',
                        focalX: 50,
                        focalY: 50,
                        dim: 45,
                      },
                    },
                    { hasBackgroundImage: image, highContrast },
                  )
                  for (const [name, text, surface] of readablePairs(tokens)) {
                    const ratio = chatContrastRatio(text, surface)
                    if (ratio < CHAT_TEXT_CONTRAST_MINIMUM) {
                      failures.push(`${theme}/${accent}/${colour}/${name}: ${ratio.toFixed(2)}`)
                    }
                  }
                  if (image && !highContrast) {
                    expect(tokens.userSurface).toBe(true)
                    expect(tokens.assistantBubble || tokens.assistantProtected).toBe(true)
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([])
  })
})
