import { describe, expect, it } from 'vitest'

import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'

import {
  buildOutreachContext,
  OUTREACH_CONTEXT_CAPS,
  publicHttpsUrl,
  type OutreachContextInput,
} from './outreach-context'

const NOW = new Date('2026-10-02T12:00:00.000Z')
const day = (offset: number) => new Date(NOW.getTime() - offset * 86_400_000)

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contact_1',
    venueId: 'venue_1',
    fullName: 'Sample Person',
    title: 'Director',
    email: 'sample@example.com',
    doNotContact: false,
    suppressionReason: null,
    suppressedAt: null,
    unsubscribedAt: null,
    complainedAt: null,
    lastHardBounceAt: null,
    permissionState: 'UNKNOWN',
    emailReadiness: 'VALID',
    updatedAt: day(3),
    ...overrides,
  } as never
}

function input(overrides: Partial<OutreachContextInput> = {}): OutreachContextInput {
  return {
    now: NOW,
    organization: {
      id: 'org_1',
      name: 'Example Museum',
      website: 'https://museum.example.com',
      type: 'museum',
      city: 'Springfield',
      region: 'IL',
      country: 'US',
      stage: 'RESEARCHED',
      archived: false,
      updatedAt: day(10),
      notes: 'Reach the director in spring.',
      customerLinked: false,
      researchProvenance: ['https://museum.example.com/about', 'http://insecure.example.com/x'],
      duplicateReview: null,
    },
    venueCount: 1,
    venue: {
      selection: 'only',
      archived: false,
      row: {
        id: 'venue_1',
        name: 'Example Museum Main Hall',
        website: null,
        venueType: 'museum',
        city: 'Springfield',
        region: 'IL',
        country: 'US',
        estimatedSize: 'M',
        fitAttributes: { b: 2, a: 1 },
        visitorOperations: {},
        researchSources: [{ url: 'https://museum.example.com/visit', label: 'Visit page' }],
        updatedAt: day(5),
      },
    },
    contact: {
      selection: 'auto',
      liveTotal: 1,
      scanned: 1,
      chosen: {
        row: contactRow(),
        draft: { eligible: true, reasons: [] },
        release: { eligible: false, reasons: ['not_verified'] },
        lastSuppressionEvent: null,
      },
      others: [],
    },
    correspondence: {
      inboundMessages: 0,
      outboundMessages: 0,
      threads: 0,
      lastInboundAt: null,
      lastOutboundAt: null,
      messageTotal: 0,
      messages: [],
      draftTotal: 0,
      drafts: [],
    },
    noteTotal: 1,
    notes: [{ id: 'note_1', occurredAt: day(2), text: 'Called the front desk.' }],
    evidenceTotal: 2,
    evidence: [
      {
        id: 'ev_1',
        venueId: 'venue_1',
        contactId: null,
        sourceType: 'website',
        sourceLabel: 'Visit page',
        sourceUrl: 'https://museum.example.com/visit',
        capturedValue: { hours: '9-5' },
        researchedAt: day(20),
      },
      {
        id: 'ev_2',
        venueId: null,
        contactId: null,
        sourceType: 'import',
        sourceLabel: null,
        sourceUrl: 'http://10.0.0.1/private',
        capturedValue: null,
        researchedAt: null,
      },
    ],
    ...overrides,
  }
}

describe('buildOutreachContext', () => {
  it('builds a pack that satisfies the published output contract', () => {
    const pack = buildOutreachContext(input())
    expect(OPERATOR_MCP_OUTPUTS['crm.get_outreach_context'].parse(pack)).toEqual(pack)
    expect(pack.drafting.allowed).toBe(true)
    expect(pack.contact.chosen?.email).toBe('sample@example.com')
    expect(pack.drafting.warnings.map((w) => w.code)).toEqual(['not_verified'])
  })

  it('is deterministic for equal input and independent of key order', () => {
    const a = buildOutreachContext(input())
    const b = buildOutreachContext(input())
    expect(b).toEqual(a)
    const reordered = input()
    reordered.venue!.row.fitAttributes = { a: 1, b: 2 }
    expect(buildOutreachContext(reordered)).toEqual(a)
    expect(a.venue?.fit?.text).toBe('{"a":1,"b":2}')
  })

  it('changes the fingerprint when a source record changes, not when only time passes', () => {
    const a = buildOutreachContext(input())
    const later = buildOutreachContext({ ...input(), now: new Date(NOW.getTime() + 86_400_000) })
    expect(later.sourceFingerprint).toBe(a.sourceFingerprint)
    expect(later.generatedAt).not.toBe(a.generatedAt)
    const edited = input()
    edited.organization.updatedAt = day(1)
    expect(buildOutreachContext(edited).sourceFingerprint).not.toBe(a.sourceFingerprint)
  })

  it('refuses drafting and withholds free text for a suppressed contact', () => {
    const base = input()
    const pack = buildOutreachContext({
      ...base,
      contact: {
        ...base.contact,
        chosen: {
          row: contactRow({ suppressedAt: day(1), suppressionReason: 'asked to stop' }),
          draft: { eligible: false, reasons: ['suppressed'] },
          release: { eligible: false, reasons: ['suppressed', 'not_verified'] },
          lastSuppressionEvent: {
            eventType: 'SUPPRESSED',
            reasonCode: 'manual',
            occurredAt: day(1),
          },
        },
      },
    })
    expect(pack.drafting.allowed).toBe(false)
    expect(pack.drafting.blockers).toEqual([
      expect.objectContaining({ code: 'suppressed', scope: 'contact', contactId: 'contact_1' }),
    ])
    expect(pack.drafting.instruction).toMatch(/Do not draft/u)
    expect(pack.contact.chosen?.email).toBeNull()
    expect(pack.contact.chosen?.flags.suppressed).toBe(true)
    expect(pack.notes).toMatchObject({ withheld: true, embedded: null, recorded: [] })
    expect(pack.evidence).toMatchObject({ withheld: true, items: [], legacySources: [] })
    expect(pack.correspondence.previewsWithheld).toBe(true)
    expect(JSON.stringify(pack)).not.toContain('sample@example.com')
    expect(OPERATOR_MCP_OUTPUTS['crm.get_outreach_context'].parse(pack)).toEqual(pack)
  })

  it.each([
    ['do not contact', { doNotContact: true }, 'do_not_contact'],
    ['unsubscribed', { unsubscribedAt: day(1) }, 'unsubscribed'],
    ['bounced', { lastHardBounceAt: day(1) }, 'bounced'],
  ])('flags a %s contact as a blocker', (_label, overrides, code) => {
    const base = input()
    const pack = buildOutreachContext({
      ...base,
      contact: {
        ...base.contact,
        chosen: {
          row: contactRow(overrides),
          draft: { eligible: false, reasons: [code] },
          release: { eligible: false, reasons: [code] },
          lastSuppressionEvent: null,
        },
      },
    })
    expect(pack.drafting.allowed).toBe(false)
    expect(pack.drafting.blockers.map((b) => b.code)).toContain(code)
  })

  it('blocks an archived or do-not-contact account and an account with no draftable contact', () => {
    const base = input()
    const none = buildOutreachContext({
      ...base,
      organization: { ...base.organization, archived: true, stage: 'DO_NOT_CONTACT' },
      contact: { ...base.contact, selection: 'none', chosen: null, liveTotal: 40, scanned: 30 },
    })
    expect(none.drafting.allowed).toBe(false)
    expect(none.drafting.blockers.map((b) => b.code)).toEqual([
      'account_archived',
      'organization_do_not_contact',
      'no_draftable_contact',
    ])
    expect(none.contact.chosen).toBeNull()
    expect(none.limits.truncatedSections).toContain('contact')
    const empty = buildOutreachContext({
      ...base,
      contact: { ...base.contact, selection: 'none', chosen: null, liveTotal: 0, scanned: 0 },
    })
    expect(empty.drafting.blockers.map((b) => b.code)).toEqual(['no_contact'])
  })

  it('reports missing evidence as unsupported claims instead of inventing support', () => {
    const base = input()
    const pack = buildOutreachContext({
      ...base,
      venue: { ...base.venue!, row: { ...base.venue!.row, estimatedSize: null } },
      evidence: [],
      evidenceTotal: 0,
      noteTotal: 0,
      notes: [],
      organization: { ...base.organization, researchProvenance: [], notes: null },
    })
    const status = Object.fromEntries(pack.claims.map((c) => [c.claim, c.status]))
    expect(status).toMatchObject({
      organization_identity: 'supported',
      venue_specific_facts: 'unsupported',
      recent_news_or_events: 'unsupported',
      visitor_volume_or_attendance: 'unsupported',
      current_pain_or_stated_need: 'unsupported',
      prior_relationship_or_conversation: 'unsupported',
      existing_customer_status: 'unsupported',
      pricing_budget_or_contract_terms: 'unsupported',
    })
    expect(pack.evidence).toMatchObject({ items: [], citableCount: 0, newestObservedAt: null })
    expect(pack.limits.complete).toBe(true)
  })

  it('carries provenance, freshness and withholds non-public URLs', () => {
    const pack = buildOutreachContext(input())
    const [first, second] = pack.evidence.items
    expect(first).toMatchObject({
      evidenceId: 'ev_1',
      scope: 'venue',
      sourceUrl: 'https://museum.example.com/visit',
      urlWithheld: false,
      freshness: { status: 'fresh', ageDays: 20 },
    })
    expect(second).toMatchObject({
      sourceUrl: null,
      urlWithheld: true,
      freshness: { status: 'unknown', ageDays: null, observedAt: null },
    })
    expect(pack.evidence.citableCount).toBe(1)
    expect(pack.evidence.legacySources.map((s) => s.sourceUrl)).toEqual([
      'https://museum.example.com/about',
      'https://museum.example.com/visit',
    ])
    expect(pack.claims.find((c) => c.claim === 'venue_specific_facts')?.status).toBe('supported')
    expect(pack.claims.find((c) => c.claim === 'recent_news_or_events')?.status).toBe('supported')
  })

  it('grades freshness by age', () => {
    const base = input()
    const make = (age: number) =>
      buildOutreachContext({
        ...base,
        evidence: [{ ...base.evidence[0]!, researchedAt: day(age) }],
      }).evidence.items[0]!.freshness.status
    expect([make(0), make(90), make(91), make(365), make(366)]).toEqual([
      'fresh',
      'fresh',
      'aging',
      'aging',
      'stale',
    ])
  })

  it('marks every cap with explicit truncation markers', () => {
    const base = input()
    const many = <T>(count: number, make: (index: number) => T) =>
      Array.from({ length: count }, (_, index) => make(index))
    const pack = buildOutreachContext({
      ...base,
      contact: {
        ...base.contact,
        liveTotal: 40,
        scanned: 30,
        others: many(30, (i) => ({
          id: `c${i}`,
          fullName: `Person ${i}`,
          title: null,
          draftEligible: true,
        })),
      },
      correspondence: {
        ...base.correspondence,
        messageTotal: 9,
        messages: many(9, (i) => ({
          id: `m${i}`,
          threadId: 't1',
          contactId: null,
          direction: 'OUTBOUND' as const,
          status: 'SENT',
          occurredAt: day(i),
          subject: 'x'.repeat(400),
          bodyPreview: 'y'.repeat(500),
          previewReadable: true,
        })),
        draftTotal: 6,
        drafts: many(6, (i) => ({
          id: `d${i}`,
          version: i + 1,
          status: 'REJECTED',
          createdAt: day(i),
          subject: 's',
          escalationFlags: [],
        })),
      },
      noteTotal: 12,
      notes: many(12, (i) => ({ id: `n${i}`, occurredAt: day(i), text: 'n'.repeat(900) })),
      evidenceTotal: 30,
      evidence: many(30, (i) => ({
        id: `e${i}`,
        venueId: null,
        contactId: null,
        sourceType: 'website',
        sourceLabel: null,
        sourceUrl: `https://example.com/${i}`,
        capturedValue: { blob: 'z'.repeat(1_000) },
        researchedAt: day(i),
      })),
    })
    expect(pack.contact.others).toHaveLength(OUTREACH_CONTEXT_CAPS.others)
    expect(pack.correspondence.recentMessages).toHaveLength(OUTREACH_CONTEXT_CAPS.messages)
    expect(pack.correspondence.priorDrafts).toHaveLength(OUTREACH_CONTEXT_CAPS.drafts)
    expect(pack.notes.recorded).toHaveLength(OUTREACH_CONTEXT_CAPS.notes)
    expect(pack.evidence.items).toHaveLength(OUTREACH_CONTEXT_CAPS.evidence)
    expect(pack.correspondence.messageSection).toMatchObject({
      total: 9,
      returned: 5,
      truncated: true,
    })
    expect(pack.evidence.section).toMatchObject({ total: 30, returned: 10, truncated: true })
    expect(pack.notes.recorded[0]!.text).toMatchObject({ truncated: true })
    expect(pack.notes.recorded[0]!.text.text).toHaveLength(500)
    expect(pack.evidence.items[0]!.capturedValue).toMatchObject({ truncated: true })
    expect(pack.correspondence.recentMessages[0]!.preview?.text).toHaveLength(300)
    expect(pack.limits.complete).toBe(false)
    expect(pack.limits.truncatedSections).toEqual(
      ['contact', 'drafts', 'evidence', 'messages', 'notes'].sort(),
    )
    expect(pack.limits.textFieldsTruncated).toBeGreaterThan(0)
    expect(OPERATOR_MCP_OUTPUTS['crm.get_outreach_context'].parse(pack)).toEqual(pack)
    // The pack stays small enough to hand to an agent whatever the account holds.
    expect(pack.limits.approxChars).toBeLessThan(30_000)
  })

  it('withholds the text of a message that belongs to a person who may not be contacted', () => {
    const base = input()
    const pack = buildOutreachContext({
      ...base,
      correspondence: {
        ...base.correspondence,
        inboundMessages: 1,
        lastInboundAt: day(1),
        messageTotal: 1,
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            contactId: 'contact_9',
            direction: 'INBOUND',
            status: 'RECEIVED',
            occurredAt: day(1),
            subject: 'Private subject',
            bodyPreview: 'Private words',
            previewReadable: false,
          },
        ],
      },
    })
    expect(JSON.stringify(pack)).not.toContain('Private')
    expect(pack.correspondence.awaitingOurReply).toBe(true)
    expect(pack.drafting.warnings.map((w) => w.code)).toContain('awaiting_our_reply')
  })

  it('withholds addresses found in free text', () => {
    const base = input()
    const pack = buildOutreachContext({
      ...base,
      notes: [{ id: 'n1', occurredAt: day(1), text: 'Write to someone@example.org soon' }],
    })
    expect(pack.notes.recorded[0]!.text.text).toBe('Write to [address withheld] soon')
  })
})

describe('publicHttpsUrl', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['http://example.com/a', null],
    ['https://user:pw@example.com/', null],
    ['https://localhost/x', null],
    ['https://10.1.2.3/x', null],
    ['https://intranet/x', null],
    ['javascript:alert(1)', null],
    ['not a url', null],
    [null, null],
  ])('%s -> %s', (value, expected) => {
    expect(publicHttpsUrl(value)).toBe(expected)
  })
})
