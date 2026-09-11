const MAX_ENTRY_PROMPT_LENGTH = 180
const MAX_ENTRY_PLACE_ID_LENGTH = 191

export type GuestEntrySource = 'qr'

export function parseEntryPrompt(value: string | null): string {
  if (value === null) return ''
  const prompt = value.trim().replace(/\s+/g, ' ')
  if (!prompt || prompt.length > MAX_ENTRY_PROMPT_LENGTH) return ''
  return prompt
}

export function parseGuestEntrySource(value: string | null): GuestEntrySource | undefined {
  return value === 'qr' ? 'qr' : undefined
}

export function parseGuestEntryPlaceId(input: {
  entry: string | null
  source: string | null
  item: string | null
}): string | undefined {
  if (input.entry !== 'guide-item' || input.source !== 'qr' || input.item === null) return undefined
  const item = input.item.trim()
  const containsControlCharacter = [...item].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
  if (!item || item.length > MAX_ENTRY_PLACE_ID_LENGTH || containsControlCharacter) return undefined
  return item
}
