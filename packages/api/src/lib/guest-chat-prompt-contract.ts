import { createHash } from 'node:crypto'

import { canonicalEvaluationJson, type CanonicalJsonValue } from '@pathfinder/contracts/evaluation'

export type GuestChatPromptManifestEntry = { id: string; prompt: string }

export function hashGuestChatPromptManifest(entries: GuestChatPromptManifestEntry[]): string {
  if (entries.length === 0) throw new Error('Prompt manifest must not be empty')
  const ids = entries.map((entry) => entry.id.normalize('NFC'))
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('Prompt manifest IDs must be nonblank and unique')
  }
  return createHash('sha256')
    .update(
      `pathfinder-guest-chat-prompt-contract-v1\n${canonicalEvaluationJson(
        entries as CanonicalJsonValue,
      )}`,
      'utf8',
    )
    .digest('hex')
}
