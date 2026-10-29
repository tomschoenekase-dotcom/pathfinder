import { createHash } from 'node:crypto'

type GuideMode = 'FULL' | 'DIRECTORY' | 'NONE'
type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A receipt of rendered sections, never a semantic or source-level licensing verdict. */
export function captureGuestEvidencePacket(
  input: {
    staticPart: string
    directoryPrompt: string
    dynamicPart: string
    mode: GuideMode
    loadStatus: string
    incomplete: boolean
    rendererTruncated: boolean
    updatedRecordCount: number
    retrievedCoveragePartial: boolean
  },
  env: Record<string, string | undefined> = process.env,
) {
  // Experimental ordering only. No facts, rules, boundaries or source budgets change.
  const venueFirst =
    env.GUEST_CHAT_CACHE_ORDER?.trim().toLowerCase() === 'venue-first' &&
    Boolean(input.directoryPrompt)
  const staticPart = venueFirst
    ? input.directoryPrompt + input.staticPart
    : input.staticPart + input.directoryPrompt
  // Existing guide cap is 120k; reserve another 40k for stable instructions/profile/alerts.
  // Do not replace an oversized exact receipt with an apparently complete truncated one.
  if (staticPart.length > 160_000 || input.dynamicPart.length > 150_000)
    throw new Error('Guest rendered evidence exceeds the retained prompt boundary')
  const section = (
    id: string,
    part: 'staticPart' | 'dynamicPart',
    start: number,
    text: string,
  ) => ({
    id,
    part,
    start,
    end: start + text.length,
    textSha256: sha256(text),
    sourceVersion: null,
  })
  const contextPacket = {
    schemaVersion: 'guest-evidence-packet-v1' as const,
    granularity: 'RENDERED_SECTIONS' as const,
    mode: input.mode,
    loadStatus: input.loadStatus,
    incomplete: input.incomplete,
    rendererTruncated: input.rendererTruncated,
    updatedRecordCount: input.updatedRecordCount,
    retrievedCoveragePartial: input.retrievedCoveragePartial,
    // These describe projection availability, never the truth/completeness of venue facts.
    guideDetail:
      input.mode === 'FULL' ? ('FULL_RENDERED' as const) : ('IDENTITY_OR_SUMMARY' as const),
    sourceVersions: 'USE_RETAINED_SOURCE_SNAPSHOTS_WHEN_PRESENT' as const,
    sections: [
      ...(venueFirst
        ? [
            section('guide', 'staticPart', 0, input.directoryPrompt),
            section(
              'instructions-and-profile',
              'staticPart',
              input.directoryPrompt.length,
              input.staticPart,
            ),
          ]
        : [
            section('instructions-and-profile', 'staticPart', 0, input.staticPart),
            section('guide', 'staticPart', input.staticPart.length, input.directoryPrompt),
          ]),
      section('turn-context', 'dynamicPart', 0, input.dynamicPart),
    ],
  }
  const system: SystemBlock[] = venueFirst
    ? [
        { type: 'text', text: input.directoryPrompt, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: input.staticPart, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: input.dynamicPart },
      ]
    : input.directoryPrompt
      ? [
          { type: 'text', text: input.staticPart },
          { type: 'text', text: input.directoryPrompt, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: input.dynamicPart },
        ]
      : [
          { type: 'text', text: input.staticPart, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: input.dynamicPart },
        ]
  return { system, staticPart, dynamicPart: input.dynamicPart, contextPacket }
}
