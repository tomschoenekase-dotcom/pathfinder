import { describe, expect, it } from 'vitest'

import { selectGuestQuestionEvidence } from './guest-question-evidence'
import { buildGuestVenueGuidePrompt, guestTopicPlaceLinks } from './guest-venue-directory'
import { createLargeVenueDisclosureFixture } from './test-fixtures/guest-large-venue-disclosure'

const fixture = createLargeVenueDisclosureFixture()

describe('large-venue hours disclosure', () => {
  it('exceeds the real full-guide threshold with mapped same-name ride topics and copied hours', () => {
    const { directory, currentDate, copiedHours, hoursSummary } = fixture
    const full = buildGuestVenueGuidePrompt(directory, {
      currentDate,
      maxFullChars: Number.MAX_SAFE_INTEGER,
    })
    expect(full.mode).toBe('FULL')
    expect(full.prompt.length).toBeGreaterThan(120_000)
    expect(full.prompt).toContain(hoursSummary.content)
    expect(directory.incomplete).toBe(false)
    expect(directory.places).toHaveLength(90)
    const links = guestTopicPlaceLinks(directory)
    for (const [index, place] of directory.places.entries()) {
      const topic = directory.knowledge[index]!
      expect(topic.title).toBe(place.name)
      expect(topic.content).toContain(copiedHours)
      expect(links.get(place.id)).toContain(topic.id)
    }
    expect(directory.knowledge.filter((topic) => topic.category === 'Hours')).toEqual([
      hoursSummary,
    ])
    expect(hoursSummary.content).toContain('CONFLICTED:')
  })

  describe.each(['default', 'evidence'] as const)('%s guide strategy', (strategy) => {
    const guide = buildGuestVenueGuidePrompt(fixture.directory, {
      currentDate: fixture.currentDate,
      ...(strategy === 'evidence' ? { strategy } : {}),
    })

    it('preserves the strategy-specific path for the caution body', () => {
      // No artificially lowered size bound: default must fall back at the production threshold.
      expect(guide.mode).toBe('DIRECTORY')
      if (strategy === 'default') {
        expect(guide.recordIds.has(`knowledge:${fixture.hoursSummary.id}`)).toBe(false)
        expect(guide.prompt).not.toContain(fixture.caution)
      } else {
        // Evidence mode also admits short Hours records whole in its core prefix.
        expect(guide.recordIds.has(`knowledge:${fixture.hoursSummary.id}`)).toBe(true)
        expect(guide.prompt).toContain(fixture.hoursSummary.content)
      }
    })

    it.each([
      'What are the park opening hours?',
      'When does the park open and close today?',
      'What does the operating calendar say for our visit?',
      'What are the opening hours for Copper Comet?',
    ])('hydrates the whole conflicted hours summary for %j', (query) => {
      const selected = selectGuestQuestionEvidence({
        query,
        venueName: fixture.venueName,
        directory: fixture.directory,
        mode: guide.mode,
        currentDate: fixture.currentDate,
        knowledgeInContext: [],
        placesInContext: [],
      })
      const governing = selected.knowledge.find((entry) => entry.id === fixture.hoursSummary.id)
      expect(governing, JSON.stringify(selected.trace)).toBeDefined()
      expect(governing?.content).toBe(fixture.hoursSummary.content)
      expect(governing?.content).toContain(fixture.caution)
      expect(selected.trace.addedKnowledgeIds).toContain(fixture.hoursSummary.id)
      expect(selected.trace.budgetExcludedIds).not.toContain(fixture.hoursSummary.id)
    })

    it('adds the caution when a copied ride schedule is already retrieved', () => {
      const copiedRide = fixture.directory.knowledge[0]!
      expect(copiedRide.content).toContain(fixture.copiedHours)
      const selected = selectGuestQuestionEvidence({
        query: 'What are the opening hours for Copper Comet?',
        venueName: fixture.venueName,
        directory: fixture.directory,
        mode: guide.mode,
        currentDate: fixture.currentDate,
        knowledgeInContext: [copiedRide],
        placesInContext: [fixture.directory.places[0]!],
      })
      expect(
        selected.knowledge.find((entry) => entry.id === fixture.hoursSummary.id)?.content,
        JSON.stringify(selected.trace),
      ).toBe(fixture.hoursSummary.content)
      expect(selected.knowledge.map((entry) => entry.id)).not.toContain(copiedRide.id)
    })
  })
})
