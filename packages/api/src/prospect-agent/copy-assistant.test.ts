import { describe, expect, it } from 'vitest'
import { ProspectCopyGroundingError, validateProspectCopyHandoff } from './copy-assistant'

const evidence = [{ reference: 'crm:org:name' }, { reference: 'source:admission-page' }]

describe('prospect copy handoff', () => {
  it('retains approved copy provenance and keeps every draft review-only', () => {
    expect(
      validateProspectCopyHandoff({
        subject: 'A visitor guide for the museum',
        textBody: 'Your museum serves families across Chicago.',
        evidence,
        claims: [
          {
            text: 'Your museum serves families across Chicago.',
            evidenceReferences: ['crm:org:name'],
          },
        ],
        copySources: [
          {
            id: 'founder-intro',
            version: '3',
            status: 'APPROVED',
            allowedUses: ['OUTREACH'],
            provenance: 'approved-copy-bank:founder-review-2026-09-01',
          },
        ],
      }),
    ).toMatchObject({ reviewRequired: true, sendAuthorized: false, warnings: [] })
  })

  it('marks proposed founder copy for review without presenting it as approved', () => {
    const result = validateProspectCopyHandoff({
      subject: 'Museum visitor questions',
      textBody: 'A short draft for review.',
      evidence,
      copySources: [
        {
          id: 'future-founder-note',
          version: '1',
          status: 'PROPOSED',
          allowedUses: ['OUTREACH'],
          provenance: 'operator-proposal:2026-09-06',
        },
      ],
    })
    expect(result.warnings).toEqual(['Draft uses proposed copy that still needs founder approval.'])
  })

  it.each([
    [
      'invalidated copy',
      {
        copySources: [
          {
            id: 'old',
            version: '1',
            status: 'INVALIDATED',
            allowedUses: ['OUTREACH'],
            provenance: 'review:1',
          },
        ],
      },
    ],
    ['unsupported price', { subject: 'Plans from $99', textBody: 'Plans start at $99 per month.' }],
    ['invented visit', { textBody: 'I visited your museum last summer.' }],
    ['invented contracted first-person visit', { textBody: "I've visited your museum." }],
    ['invented contracted plural visit', { textBody: "We've visited your museum." }],
    ['invented curly-contracted visit', { textBody: 'We\u2019ve visited your museum.' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() =>
      validateProspectCopyHandoff({
        subject: 'Hello',
        textBody: 'Draft body.',
        evidence,
        ...(overrides as Record<string, unknown>),
      }),
    ).toThrow(ProspectCopyGroundingError)
  })

  it('accepts an evidence-linked contracted relationship claim only as review-only copy', () => {
    expect(
      validateProspectCopyHandoff({
        subject: 'A visitor guide for the museum',
        textBody: "We've visited your museum.",
        evidence: [{ reference: 'fixture:operator-visit-record' }],
        claims: [
          {
            text: "We've visited your museum.",
            evidenceReferences: ['fixture:operator-visit-record'],
          },
        ],
      }),
    ).toMatchObject({ reviewRequired: true, sendAuthorized: false })
  })

  it('rejects claim references absent from the draft evidence bundle', () => {
    expect(() =>
      validateProspectCopyHandoff({
        subject: 'Admission planning',
        textBody: 'Admission is $20.',
        evidence,
        claims: [{ text: 'Admission is $20.', evidenceReferences: ['source:missing'] }],
      }),
    ).toThrow(/requires referenced draft evidence/)
  })

  it('requires separate evidence linkage for every consequential sentence including subject claims', () => {
    expect(() =>
      validateProspectCopyHandoff({
        subject: 'Plans start at $20.',
        textBody: 'Plans start at $20. We guarantee a visitor result.',
        evidence,
        claims: [{ text: 'Plans start at $20.', evidenceReferences: ['source:admission-page'] }],
      }),
    ).toThrow(/Each pricing, relationship, result, or commitment sentence/)
  })
})
