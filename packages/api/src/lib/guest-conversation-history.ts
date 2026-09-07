export const INTERRUPTED_VOICE_PREFIX = '[Interrupted] '

const MODEL_VOICE_ENTRY_LIMIT = 2_000
const MODEL_VOICE_TRUNCATION_MARKER = '\n[transcript truncated]'

export type GuestTextHistoryRow = {
  id: string
  role: string
  content: string
  createdAt: Date
  sessionSequence: number
  guestChatTurn?: { replayMetadata: unknown } | null
}

export type GuestVoiceHistoryRow = {
  id: string
  voiceSessionId: string
  providerEventId: string
  sequence: number
  speaker: 'VISITOR' | 'ASSISTANT'
  text: string
  createdAt: Date
}

export type GuestConversationEntry =
  | { kind: 'text'; row: GuestTextHistoryRow; sortTime: number; sortKey: string }
  | {
      kind: 'voice'
      row: GuestVoiceHistoryRow
      interrupted: boolean
      sortTime: number
      sortKey: string
    }

function compareStableKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function mergeGuestConversationEntries(input: {
  textRows: GuestTextHistoryRow[]
  voiceRows: GuestVoiceHistoryRow[]
  limit: number
}): GuestConversationEntry[] {
  let effectiveTextTime: number | null = null
  const textEntries: GuestConversationEntry[] = [...input.textRows]
    .sort(
      (left, right) =>
        left.sessionSequence - right.sessionSequence || compareStableKeys(left.id, right.id),
    )
    .map((row) => {
      const receiptTime = row.createdAt.getTime()
      effectiveTextTime = Math.max(effectiveTextTime ?? receiptTime, receiptTime)
      return {
        kind: 'text' as const,
        sortTime: effectiveTextTime,
        sortKey: `text:${String(row.sessionSequence).padStart(12, '0')}:${row.id}`,
        row,
      }
    })

  const effectiveVoiceTimes = new Map<string, number>()
  const voiceEntries: GuestConversationEntry[] = [...input.voiceRows]
    .sort(
      (left, right) =>
        compareStableKeys(left.voiceSessionId, right.voiceSessionId) ||
        left.sequence - right.sequence ||
        compareStableKeys(left.id, right.id),
    )
    .map((row) => {
      const receiptTime = row.createdAt.getTime()
      const effectiveTime = Math.max(
        effectiveVoiceTimes.get(row.voiceSessionId) ?? receiptTime,
        receiptTime,
      )
      effectiveVoiceTimes.set(row.voiceSessionId, effectiveTime)
      return {
        kind: 'voice' as const,
        sortTime: effectiveTime,
        sortKey: `voice:${row.voiceSessionId}:${String(row.sequence).padStart(12, '0')}:${row.id}`,
        row,
        interrupted: row.speaker === 'ASSISTANT' && row.text.startsWith(INTERRUPTED_VOICE_PREFIX),
      }
    })

  return [...textEntries, ...voiceEntries]
    .sort(
      (left, right) =>
        left.sortTime - right.sortTime || compareStableKeys(left.sortKey, right.sortKey),
    )
    .slice(-input.limit)
}

function boundedVoiceModelContent(label: string, text: string): string {
  const full = `${label}\n${text.trim()}`
  if (full.length <= MODEL_VOICE_ENTRY_LIMIT) return full
  return `${full.slice(0, MODEL_VOICE_ENTRY_LIMIT - MODEL_VOICE_TRUNCATION_MARKER.length)}${MODEL_VOICE_TRUNCATION_MARKER}`
}

export function projectGuestModelHistory(
  entries: GuestConversationEntry[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return entries.map((entry) => {
    if (entry.kind === 'text') {
      return { role: entry.row.role as 'user' | 'assistant', content: entry.row.content }
    }
    if (entry.row.speaker === 'VISITOR') {
      return {
        role: 'user' as const,
        content: boundedVoiceModelContent(
          '[Voice transcript data: visitor speech captured by the browser; transcription is unverified]',
          entry.row.text,
        ),
      }
    }
    const text = entry.interrupted
      ? entry.row.text.slice(INTERRUPTED_VOICE_PREFIX.length)
      : entry.row.text
    return {
      role: 'assistant' as const,
      content: boundedVoiceModelContent(
        entry.interrupted
          ? '[Voice transcript data: assistant output was interrupted, may be incomplete, and may not have been heard by the visitor]'
          : '[Voice transcript data: assistant output was captured; playback to the visitor is not confirmed]',
        text,
      ),
    }
  })
}
