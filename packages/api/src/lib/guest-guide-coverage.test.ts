import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildGuestGuideCoverage, projectGuestGuideCoverage } from './guest-guide-coverage'
import { buildGuestVenueGuidePrompt, type GuestVenueDirectory } from './guest-venue-directory'
import { buildGuestAnswerEvidenceBundle, verifyGuestAnswerEvidenceBundle } from './guest-answer-evidence'
import { THEME_PARK_PLACES } from './evaluation/guest-answer-quality-corpus'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const empty: GuestVenueDirectory = { places: [], knowledge: [], incomplete: false }
const directory: GuestVenueDirectory = {
  ...empty,
  places: [
    { ...THEME_PARK_PLACES[0]!, id: 'p-one', name: 'Lantern Hall' },
    { ...THEME_PARK_PLACES[0]!, id: 'p-two', name: 'Lantern Hall' },
  ],
  knowledge: [
    { id: 'k-food', title: 'Juniper Cafe', category: 'Dining', content: 'Soup and salads. Contains wheat.', sourceType: 'manual', sourceName: null, sourceUrl: null },
    { id: 'k-past', title: 'Bloom Festival 2024', category: 'Events', content: 'PAST DETAIL', sourceType: 'manual', sourceName: null, sourceUrl: null },
  ],
}
const render = (data: GuestVenueDirectory, maxFullChars?: number) => buildGuestVenueGuidePrompt(data, {
  currentDate: '2026-10-07', ...(maxFullChars !== undefined ? { maxFullChars } : {}),
})
const coverage = (data: GuestVenueDirectory, maxFullChars?: number) => buildGuestGuideCoverage({
  directory: data, guide: render(data, maxFullChars), loadStatus: 'READY', projectionPath: 'LEGACY',
})

describe('actual guide coverage evidence', () => {
  it('hashes the actual FULL prompt and counts only actual record bodies', () => {
    const guide = render(directory)
    const observed = coverage(directory)
    expect(observed).toMatchObject({ mode: 'FULL', placeCount: 2, knowledgeCount: 2, includedDetailCount: 1 })
    expect(guide.prompt).toContain('Contains wheat.')
    expect(guide.prompt).not.toContain('PAST DETAIL')
    expect(observed.promptSha256).toBe(digest(guide.prompt))
    expect(observed.detailIdSetSha256).toBe(digest(JSON.stringify(['knowledge:k-food'])))
    expect(guide).toEqual(render(directory)) // Observation did not mutate rendering.
  })
  it('distinguishes DIRECTORY size fallback from incomplete coverage without claiming full details', () => {
    expect(coverage(directory, 1)).toMatchObject({ mode: 'DIRECTORY', incomplete: false, includedDetailCount: 0 })
    expect(render(directory, 1).prompt).not.toContain('Contains wheat.')
    expect(coverage({ ...directory, incomplete: true })).toMatchObject({ mode: 'DIRECTORY', incomplete: true })
  })
  it.each(['READY', 'LOAD_FAILED', 'PROJECTION_MISMATCH'] as const)('retains %s separately from an empty rendering', (loadStatus) => {
    expect(buildGuestGuideCoverage({ guide: render(empty), directory: empty, loadStatus, projectionPath: 'LEGACY' }))
      .toMatchObject({ mode: 'NONE', loadStatus, promptChars: 0 })
  })
  it('preserves historical unknown, validates stored metadata and detects tampering', () => {
    const bundle = (snapshot: unknown) => buildGuestAnswerEvidenceBundle({
      assistantResponse: 'Try the soup.', staticSystemPrompt: 'Static rules.', dynamicSystemPrompt: 'Current facts.',
      sources: [{ sourceId: 'venue:fictional', kind: 'VENUE_PROFILE', label: 'Fictional park', snapshot }],
    })
    const historical = bundle({ name: 'Fictional park' })
    expect(projectGuestGuideCoverage({ evidence: historical, assistantResponse: 'Try the soup.' })).toEqual({ guideCoverageState: 'UNKNOWN', guideCoverage: null })
    expect(verifyGuestAnswerEvidenceBundle({ assistantResponse: 'Try the soup.', evidence: historical })).toBe(true)
    const current = bundle({ guideCoverage: coverage(directory) })
    expect(projectGuestGuideCoverage({ evidence: current, assistantResponse: 'Try the soup.' }).guideCoverageState).toBe('KNOWN')
    expect(verifyGuestAnswerEvidenceBundle({ assistantResponse: 'Try the soup.', evidence: current })).toBe(true)
    const changed = { ...current.sources[0]!, snapshot: current.sources[0]!.snapshot.replace('FULL', 'NONE') }
    expect(projectGuestGuideCoverage({ evidence: { ...current, sources: [changed] }, assistantResponse: 'Try the soup.' }).guideCoverageState).toBe('UNKNOWN')
    expect(verifyGuestAnswerEvidenceBundle({ assistantResponse: 'Try the soup.', evidence: { ...current, sources: [changed] } })).toBe(false)
    expect(projectGuestGuideCoverage({ evidence: bundle({ guideCoverage: { ...coverage(empty), schemaVersion: 'future-v2' } }), assistantResponse: 'Try the soup.' }).guideCoverageState).toBe('UNKNOWN')
    const rehashed = { ...changed, snapshotHash: digest(changed.snapshot) }
    const staleOverall = { ...current, sources: [rehashed] }
    expect(rehashed.snapshotHash).toBe(digest(rehashed.snapshot))
    expect(verifyGuestAnswerEvidenceBundle({ assistantResponse: 'Try the soup.', evidence: staleOverall })).toBe(false)
    expect(projectGuestGuideCoverage({ evidence: staleOverall, assistantResponse: 'Try the soup.' }).guideCoverageState).toBe('UNKNOWN')
    expect(projectGuestGuideCoverage({ evidence: current, assistantResponse: 'Different answer.' }).guideCoverageState).toBe('UNKNOWN')
    expect(projectGuestGuideCoverage({ evidence: current, assistantResponse: null }).guideCoverageState).toBe('UNKNOWN')
    expect(projectGuestGuideCoverage({ evidence: null, assistantResponse: 'Try the soup.' }).guideCoverageState).toBe('UNKNOWN')
    const text = JSON.stringify(projectGuestGuideCoverage({ evidence: current, assistantResponse: 'Try the soup.' }))
    expect(text).not.toContain('Contains wheat.')
    expect(text).not.toContain('knowledge:k-food')
  })
})
