import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  forgetPendingChatTurn,
  readPendingChatTurn,
  rememberPendingChatTurn,
  type RecoverableChatInput,
} from './pending-chat-turn'

const input: RecoverableChatInput = {
  operationId: '123e4567-e89b-42d3-a456-426614174001',
  anonymousToken: '123e4567-e89b-42d3-a456-426614174002',
  venueId: 'venue-1',
  message: 'We have 20 minutes and need a quiet activity.',
  language: '日本語',
  entryPlaceId: 'gallery-1',
  responseIntent: 'EXPAND',
  lat: 0,
  lng: 0,
}
const storageKey = `torchiko:visitor-turn:${input.venueId}:${input.anonymousToken}`

describe('tab-scoped exact pending turn', () => {
  beforeEach(() => window.sessionStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('preserves every frozen field without manufacturing a profile', () => {
    expect(rememberPendingChatTurn(input)).toBe(true)
    expect(readPendingChatTurn(input)).toEqual({ kind: 'found', input })
    expect(JSON.parse(window.sessionStorage.getItem(storageKey)!).input).not.toHaveProperty(
      'visitContext',
    )
  })
  it('does not cross a venue, session or employee access scope', () => {
    rememberPendingChatTurn(input)
    expect(readPendingChatTurn({ ...input, venueId: 'other' })).toEqual({ kind: 'empty' })
    expect(
      readPendingChatTurn({ ...input, anonymousToken: '123e4567-e89b-42d3-a456-426614174003' }),
    ).toEqual({ kind: 'empty' })
    expect(
      readPendingChatTurn({ ...input, secondLayerKey: '123e4567-e89b-42d3-a456-426614174004' }),
    ).toEqual({ kind: 'invalid' })
  })
  it.each([
    '{',
    JSON.stringify({ version: 2, input }),
    JSON.stringify({ version: 1, input: { ...input, operationId: 'not-an-id' } }),
    ' '.repeat(16_385),
  ])('fails closed for malformed recovery data %#', (value) => {
    window.sessionStorage.setItem(storageKey, value)
    expect(readPendingChatTurn(input)).toEqual({ kind: 'invalid' })
    expect(window.sessionStorage.getItem(storageKey)).toBe(value)
  })
  it('clears only the matching completed operation, not a successor or an unsent draft', () => {
    const draftKey = `torchiko:visitor-draft:${input.venueId}:${input.anonymousToken}`
    window.sessionStorage.setItem(draftKey, 'My next question')
    rememberPendingChatTurn(input)
    forgetPendingChatTurn({ ...input, operationId: '123e4567-e89b-42d3-a456-426614174005' })
    expect(readPendingChatTurn(input).kind).toBe('found')
    forgetPendingChatTurn(input)
    expect(readPendingChatTurn(input).kind).toBe('empty')
    expect(window.sessionStorage.getItem(draftKey)).toBe('My next question')
  })
  it('degrades without exceptions when browser storage is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(rememberPendingChatTurn(input)).toBe(false)
    expect(readPendingChatTurn(input)).toEqual({ kind: 'unavailable' })
    expect(() => forgetPendingChatTurn(input)).not.toThrow()
  })
})
