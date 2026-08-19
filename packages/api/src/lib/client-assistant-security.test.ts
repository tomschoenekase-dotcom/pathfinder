import { describe, expect, it } from 'vitest'

import {
  boundedClientAssistantHistory,
  buildClientAssistantContext,
  parseClientTochiQuestion,
  projectClientTochiResponse,
  safeClientTochiFailureReply,
  safeHandoffExcerpt,
} from './client-assistant-security'

const source = {
  venue: {
    id: 'venue-1',
    name: 'City Museum',
    tonePreset: 'friendly',
    presentationMode: 'CLASSIC',
  },
  lifecycle: {
    stage: 'SHARE',
    summary: 'Materials are being collected.',
    currentAction: 'Share venue information.',
  },
  uploads: {
    total: 12,
    recent: Array.from({ length: 15 }, (_, index) => ({ fileName: `file-${index}.pdf` })),
  },
  pendingQuestionCount: 2,
}

describe('client assistant security projection', () => {
  it('builds only a bounded client-visible context and caps recent filenames', () => {
    const context = buildClientAssistantContext(source)
    expect(context).toMatchObject({
      venueId: 'venue-1',
      venueName: 'City Museum',
      onboardingStage: 'SHARE',
      tonePreset: 'friendly',
      presentationMode: 'CLASSIC',
      allowedRoutes: {
        home: '/',
        information: '/information',
        help: '/support',
        venueBotSettings: '/ai-controls',
      },
    })
    expect(context.uploadedMaterials?.recentFilenames).toHaveLength(10)
    expect(JSON.stringify(context)).not.toMatch(/tenant|agent|credential|cost|provider/iu)
  })

  it('drops unsupported legacy state instead of passing it into the prompt', () => {
    const context = buildClientAssistantContext({
      ...source,
      venue: { ...source.venue, tonePreset: 'raw-user-prompt', presentationMode: 'EXPERIMENTAL' },
      lifecycle: { ...source.lifecycle, stage: 'INTERNAL_REVIEW' },
    })
    expect(context.tonePreset).toBeUndefined()
    expect(context.presentationMode).toBeUndefined()
    expect(context.onboardingStage).toBeUndefined()
  })

  it('rejects empty, oversized, and NUL-bearing questions before work', () => {
    for (const question of ['', ' '.repeat(10), 'x'.repeat(2_001), 'hello\0world']) {
      expect(() => parseClientTochiQuestion(question)).toThrow()
    }
    expect(parseClientTochiQuestion('  What should I upload?  ')).toBe('What should I upload?')
  })

  it('resolves a model route key through the server-owned allowlist', () => {
    const context = buildClientAssistantContext(source)
    const reply = projectClientTochiResponse(
      {
        answer: 'Open your venue information.',
        category: 'portal-navigation',
        action: { type: 'navigate', routeKey: 'information', label: 'Open Information' },
      },
      context,
    )
    expect(reply.action).toEqual({
      type: 'navigate',
      href: '/information',
      label: 'Open Information',
    })
    expect(JSON.stringify(reply)).not.toContain('http')
  })

  it('projects a handoff as a preview rather than a submitted request', () => {
    const reply = projectClientTochiResponse(
      {
        answer: 'Nothing is submitted until you confirm.',
        category: 'support-handoff',
        action: {
          type: 'preview-support-handoff',
          category: 'EXPERIENCE_BEHAVIOR',
          summary: 'Review a POS integration',
          requestedOutcome: 'Assess secure ticket purchase support.',
        },
      },
      buildClientAssistantContext(source),
    )
    expect(reply.action).toMatchObject({ type: 'preview-support-handoff' })
    expect(reply).not.toHaveProperty('requestId')
  })

  it('returns a non-deceptive fail-open reply with ordinary support available', () => {
    const reply = safeClientTochiFailureReply()
    expect(reply.answer).toContain('portal still works normally')
    expect(reply.action).toEqual({
      type: 'navigate',
      href: '/support',
      label: 'Open Help & changes',
    })
    expect(reply.answer).not.toMatch(/human is|team is working|completed/iu)
  })

  it('bounds history and support excerpts without persisting arbitrary conversation volume', () => {
    const turns = Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `turn-${index}-${'x'.repeat(1_500)}`,
    }))
    const history = boundedClientAssistantHistory(turns)
    expect(history).toHaveLength(8)
    expect(Math.max(...history.map((turn) => turn.content.length))).toBeLessThanOrEqual(1_200)
    const excerpt = safeHandoffExcerpt(turns)
    expect(excerpt).toHaveLength(4)
    expect(Math.max(...excerpt.map((turn) => turn.content.length))).toBeLessThanOrEqual(300)
  })
})
