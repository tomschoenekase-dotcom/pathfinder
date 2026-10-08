import { createHash } from 'node:crypto'
import {
  GuestGuideCoverageSchema,
  type GuestGuideCoverage,
  type GuestAnswerEvidenceBundle,
} from '@pathfinder/contracts/guest-answer-attribution'
import type { GuestVenueDirectory, GuestVenueGuidePrompt } from './guest-venue-directory'
import { verifyGuestAnswerEvidenceBundle } from './guest-answer-evidence'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Hash only rendered context and actual body IDs; no prompts or IDs enter operator output. */
export function buildGuestGuideCoverage(input: {
  guide: GuestVenueGuidePrompt
  directory: GuestVenueDirectory
  loadStatus: GuestGuideCoverage['loadStatus']
  projectionPath: GuestGuideCoverage['projectionPath']
}): GuestGuideCoverage {
  return GuestGuideCoverageSchema.parse({
    schemaVersion: 'guest-guide-coverage-v1',
    mode: input.guide.mode,
    loadStatus: input.loadStatus,
    projectionPath: input.projectionPath,
    incomplete: input.directory.incomplete,
    placeCount: input.directory.places.length,
    knowledgeCount: input.directory.knowledge.length,
    includedDetailCount: input.guide.recordIds.size,
    promptChars: input.guide.prompt.length,
    promptSha256: hash(input.guide.prompt),
    detailIdSetSha256: hash(JSON.stringify([...input.guide.recordIds].sort())),
  })
}

/** Old, corrupt or unsupported coverage stays unknown, never a successful empty inventory. */
export function projectGuestGuideCoverage(input: {
  evidence: GuestAnswerEvidenceBundle | null
  assistantResponse: string | null
}) {
  const unknown = { guideCoverageState: 'UNKNOWN' as const, guideCoverage: null }
  if (!input.evidence || input.assistantResponse === null) return unknown
  try {
    if (!verifyGuestAnswerEvidenceBundle({
      evidence: input.evidence, assistantResponse: input.assistantResponse,
    })) return unknown
    const profiles = input.evidence.sources.filter((source) => source.kind === 'VENUE_PROFILE')
    if (profiles.length !== 1) return unknown
    const snapshot: unknown = JSON.parse(profiles[0]!.snapshot)
    const value = snapshot && typeof snapshot === 'object'
      ? (snapshot as Record<string, unknown>).guideCoverage : undefined
    const parsed = GuestGuideCoverageSchema.safeParse(value)
    if (parsed.success)
      return { guideCoverageState: 'KNOWN' as const, guideCoverage: parsed.data }
  } catch { /* Malformed historical bundles do not break operator evidence reads. */ }
  return unknown
}
