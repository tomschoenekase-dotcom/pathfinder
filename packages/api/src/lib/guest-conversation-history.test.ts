import { describe, expect, it } from 'vitest'

import {
  mergeGuestConversationEntries,
  projectGuestModelHistory,
  type GuestTextHistoryRow,
  type GuestVoiceHistoryRow,
} from './guest-conversation-history'

const textRows: GuestTextHistoryRow[] = [
  {
    id: 'text-2',
    role: 'assistant',
    content: 'Second text',
    sessionSequence: 2,
    createdAt: new Date('2026-09-07T15:59:00.000Z'),
  },
  {
    id: 'text-1',
    role: 'user',
    content: 'First text',
    sessionSequence: 1,
    createdAt: new Date('2026-09-07T16:00:00.000Z'),
  },
]

const voiceRows: GuestVoiceHistoryRow[] = [
  {
    id: 'voice-2',
    voiceSessionId: '11111111-1111-4111-8111-111111111111',
    providerEventId: 'event-2',
    sequence: 2,
    speaker: 'ASSISTANT',
    text: '[Interrupted] Use the east corridor.',
    createdAt: new Date('2026-09-07T16:01:00.000Z'),
  },
  {
    id: 'voice-1',
    voiceSessionId: '11111111-1111-4111-8111-111111111111',
    providerEventId: 'event-1',
    sequence: 1,
    speaker: 'VISITOR',
    text: 'Where is the quiet route?',
    createdAt: new Date('2026-09-07T16:02:00.000Z'),
  },
]

describe('guest conversation history', () => {
  it('preserves authoritative sequence inside each source despite inverted receipt timestamps', () => {
    const entries = mergeGuestConversationEntries({ textRows, voiceRows, limit: 10 })

    expect(entries.map((entry) => entry.row.id)).toEqual(['text-1', 'text-2', 'voice-1', 'voice-2'])
  })

  it('qualifies stored voice data without inferring playback and bounds model content', () => {
    const longVoice = { ...voiceRows[0]!, text: `[Interrupted] ${'x'.repeat(8_000)}` }
    const projected = projectGuestModelHistory(
      mergeGuestConversationEntries({
        textRows: [],
        voiceRows: [voiceRows[1]!, longVoice],
        limit: 10,
      }),
    )

    expect(projected[0]).toEqual({
      role: 'user',
      content:
        '[Voice transcript data: visitor speech captured by the browser; transcription is unverified]\nWhere is the quiet route?',
    })
    expect(projected[1]?.role).toBe('assistant')
    expect(projected[1]?.content).toContain('assistant output was interrupted')
    expect(projected[1]?.content).not.toContain('[Interrupted]')
    expect(projected[1]?.content).toHaveLength(2_000)
    expect(projected[1]?.content.endsWith('[transcript truncated]')).toBe(true)
  })

  it('keeps only the newest combined bounded window', () => {
    const entries = mergeGuestConversationEntries({
      textRows: Array.from({ length: 10 }, (_, index) => ({
        id: `text-${index + 1}`,
        role: 'user',
        content: `Text ${index + 1}`,
        sessionSequence: index + 1,
        createdAt: new Date(Date.UTC(2026, 8, 7, 16, index, 0)),
      })),
      voiceRows: [
        {
          ...voiceRows[1]!,
          createdAt: new Date('2026-09-07T16:10:00.000Z'),
        },
      ],
      limit: 10,
    })

    expect(entries).toHaveLength(10)
    expect(entries.some((entry) => entry.row.id === 'text-1')).toBe(false)
    expect(entries.at(-1)?.row.id).toBe('voice-1')
  })
})
