const MAX_ENTRY_PROMPT_LENGTH = 180

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
