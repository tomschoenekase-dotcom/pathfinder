import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { getIntakeProposalReview, onboardingBootstrapInputHash } from '@pathfinder/db'

import { buildInterviewClarificationReview } from './intake-interview-clarifications'
import { buildIntakeVenuePackageCandidate } from './intake-venue-package-candidate'

const consentHash = createHash('sha256')
  .update(
    'I consent to PathFinder using these written answers to prepare a reviewable venue-content draft.',
  )
  .digest('hex')

function db(run: unknown, reviewRun: unknown = run) {
  const findFirst = vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(reviewRun)
  return {
    intakeRun: { findFirst },
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-a' }) },
  }
}

function bootstrapRun(content: unknown, overrides: Record<string, unknown> = {}) {
  const venue = {
    name: 'Museum',
    slug: 'museum',
    guideMode: 'non_location' as const,
  }
  const bootstrapHash = onboardingBootstrapInputHash({
    venue,
    proposal: { version: 1, content } as Parameters<
      typeof onboardingBootstrapInputHash
    >[0]['proposal'],
  })
  return {
    id: 'run-a',
    sourceKind: 'STRUCTURED_BOOTSTRAP',
    status: 'AWAITING_REVIEW',
    packageHandoff: null,
    submissionInputHash: bootstrapHash,
    venue: { ...venue, category: null, defaultCenterLat: null, defaultCenterLng: null },
    evidence: [
      {
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        locator: 'onboarding:structured-bootstrap:v1',
        normalizedHash: bootstrapHash,
        confidence: 1,
      },
    ],
    structuredBootstrap: { version: 1, content },
    ...overrides,
  }
}

function fileExtractionReviewRun(overrides: Record<string, unknown> = {}) {
  const reviewId = '4d8bb6f8-f1d7-42ee-944d-2a628fa50f77'
  const receiptId = '975140d8-5af9-4c2d-9132-40b5cf6f5962'
  const proposalNotes = 'The east entrance is step-free.'
  const proposalNotesHash = createHash('sha256').update(proposalNotes).digest('hex')
  const requestHash = 'c'.repeat(64)
  const sourceSha256 = 'b'.repeat(64)
  const extractedTextHash = 'a'.repeat(64)
  return {
    id: 'proposal-run-a',
    sourceKind: 'STRUCTURED_BOOTSTRAP',
    status: 'AWAITING_REVIEW',
    displayName: 'Reviewed visitor information',
    structuredBootstrap: {
      kind: 'FILE_EXTRACTION_REVIEW',
      sourceRunId: 'source-run-a',
      receiptId,
      sourceSha256,
      sourceMimeType: 'text/plain',
      extractedTextHash,
      proposalNotes,
      proposalNotesHash,
      reviewRationale: 'The selected statement is clear and relevant.',
    },
    submissionRequestId: reviewId,
    submissionInputHash: requestHash,
    requestedBy: 'admin-a',
    requestedByType: 'HUMAN',
    packageHandoff: null,
    venue: {
      name: 'Museum',
      slug: 'museum',
      category: null,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
    },
    evidence: [
      {
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        locator: `intake-file-extraction-review:${reviewId}`,
        normalizedHash: proposalNotesHash,
        confidence: 1,
      },
    ],
    fileExtractionProposalReview: {
      id: reviewId,
      sourceRunId: 'source-run-a',
      receiptId,
      requestId: reviewId,
      requestHash,
      decision: 'ACCEPTED_FOR_PROPOSAL',
      expectedExtractedTextHash: extractedTextHash,
      proposalTitle: 'Reviewed visitor information',
      proposalNotes,
      proposalNotesHash,
      rationale: 'The selected statement is clear and relevant.',
      createdBy: 'admin-a',
      receipt: { sourceSha256, sourceMimeType: 'text/plain' },
    },
    ...overrides,
  }
}

function interviewRun(entries: ReadonlyArray<readonly [string, string]>, reverse = false) {
  const manifests = entries.map(([questionId, text]) => ({
    questionId,
    privacy: 'PUBLIC_CANDIDATE',
    skipped: false,
    redacted: false,
    uncertain: false,
    confidence: 0.8,
    normalizedHash: createHash('sha256')
      .update(`${questionId}:PUBLIC_CANDIDATE:${text}`)
      .digest('hex'),
  }))
  const ordered = reverse ? [...manifests].reverse() : manifests
  const missingPublic = ['operations.hours', 'operations.closures']
    .filter((questionId) => !entries.some(([candidateId]) => candidateId === questionId))
    .map((questionId) => ({
      questionId,
      privacy: 'PUBLIC_CANDIDATE',
      skipped: true,
      redacted: false,
      uncertain: false,
      confidence: 0.8,
      normalizedHash: null,
    }))
  return {
    id: 'run-a',
    sourceKind: 'INTERVIEW',
    status: 'AWAITING_REVIEW',
    displayName: 'Interview',
    interviewRole: 'OPERATIONS',
    interviewConsentTextHash: consentHash,
    interviewPublicAnswers: ordered.map((answer) => ({
      questionId: answer.questionId,
      text: entries.find(([questionId]) => questionId === answer.questionId)![1],
      privacy: 'PUBLIC_CANDIDATE',
      confidence: 0.8,
    })),
    interviewAnswerManifest: [
      ...ordered,
      ...missingPublic,
      {
        questionId: 'operations.internal-procedures',
        privacy: 'PRIVATE',
        skipped: false,
        redacted: true,
        uncertain: false,
        confidence: 0.8,
        normalizedHash: null,
      },
    ],
    evidence: ordered.map((answer, index) => ({
      id: `e${index}`,
      sourceKind: 'INTERVIEW',
      locator: `interview:question:${answer.questionId}:PUBLIC_CANDIDATE`,
      normalizedHash: answer.normalizedHash,
      confidence: 0.8,
      capturedAt: new Date(index),
    })),
    events: [],
    createdAt: new Date(),
  }
}

describe('deterministic intake VenuePackage candidate', () => {
  it('maps an exact accepted extraction review into a stable human-authored knowledge candidate', async () => {
    const first = await buildIntakeVenuePackageCandidate({
      db: db(fileExtractionReviewRun()) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'proposal-run-a',
    })
    const second = await buildIntakeVenuePackageCandidate({
      db: db(fileExtractionReviewRun()) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'proposal-run-a',
    })

    expect(first).toMatchObject({
      ready: true,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      summary: { candidateCount: 1, issueCount: 0 },
      autoApprove: false,
      autoApply: false,
      published: false,
    })
    expect(first.payload?.knowledgeEntries.create[0]).toMatchObject({
      provenance: {
        sourceType: 'PATHFINDER_INTAKE',
        contentOrigin: 'HUMAN_AUTHORED',
        sourceName: 'Reviewed file extraction proposal',
      },
      value: {
        title: 'Reviewed visitor information',
        category: 'DOCUMENT_REVIEW',
        content: 'The east entrance is step-free.',
        isEnabled: true,
      },
    })
    expect(second.candidateHash).toBe(first.candidateHash)
    expect(second.payload?.knowledgeEntries.create[0]?.itemKey).toBe(
      first.payload?.knowledgeEntries.create[0]?.itemKey,
    )
  })

  it('fails closed on extraction-review relation, hash, actor, or evidence drift', async () => {
    const exact = fileExtractionReviewRun()
    const variants = [
      { ...exact, fileExtractionProposalReview: null },
      { ...exact, requestedBy: 'different-admin' },
      {
        ...exact,
        structuredBootstrap: {
          ...(exact.structuredBootstrap as Record<string, unknown>),
          proposalNotes: 'Changed after review.',
        },
      },
      {
        ...exact,
        evidence: [
          {
            ...(exact.evidence as Array<Record<string, unknown>>)[0],
            locator: 'intake-file-extraction-review:different',
          },
        ],
      },
    ]
    for (const run of variants) {
      await expect(
        buildIntakeVenuePackageCandidate({
          db: db(run) as never,
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          runId: 'proposal-run-a',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_EVIDENCE',
        message: 'Stored file extraction review evidence is invalid',
      })
    }
  })

  it('does not truncate reviewed extraction notes outside VenuePackage bounds', async () => {
    const proposalNotes = 'x'.repeat(10_001)
    const proposalNotesHash = createHash('sha256').update(proposalNotes).digest('hex')
    const exact = fileExtractionReviewRun()
    const result = await buildIntakeVenuePackageCandidate({
      db: db({
        ...exact,
        structuredBootstrap: {
          ...(exact.structuredBootstrap as Record<string, unknown>),
          proposalNotes,
          proposalNotesHash,
        },
        evidence: [
          {
            ...(exact.evidence as Array<Record<string, unknown>>)[0],
            normalizedHash: proposalNotesHash,
          },
        ],
        fileExtractionProposalReview: {
          ...(exact.fileExtractionProposalReview as Record<string, unknown>),
          proposalNotes,
          proposalNotesHash,
        },
      }) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'proposal-run-a',
    })
    expect(result).toMatchObject({
      ready: false,
      payload: null,
      issues: [expect.objectContaining({ code: 'PACKAGE_FIELD_INVALID' })],
    })
  })

  it('maps exact validated bootstrap knowledge and returns a stable strict V3 payload', async () => {
    const content = {
      kind: 'knowledge',
      value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
    }
    const client = db(bootstrapRun(content))
    const input = { db: client as never, tenantId: 'tenant-a', venueId: 'venue-a', runId: 'run-a' }
    const first = await buildIntakeVenuePackageCandidate(input)
    const secondClient = db(bootstrapRun(content))
    const second = await buildIntakeVenuePackageCandidate({ ...input, db: secondClient as never })
    expect(first).toMatchObject({
      ready: true,
      payload: { schemaVersion: 3 },
      autoApply: false,
      published: false,
    })
    expect(first.payload?.knowledgeEntries.create[0]).toMatchObject({
      provenance: { sourceType: 'PATHFINDER_INTAKE', contentOrigin: 'HUMAN_AUTHORED' },
      value: { title: 'Hours', content: 'Open daily.', isEnabled: true },
    })
    expect(first.payload?.knowledgeEntries.create[0]?.itemKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(second.payload?.knowledgeEntries.create[0]?.itemKey).toBe(
      first.payload?.knowledgeEntries.create[0]?.itemKey,
    )
  })

  it('fails closed rather than truncating bootstrap fields outside VenuePackage bounds', async () => {
    const client = db(
      bootstrapRun({
        kind: 'knowledge',
        value: { title: 'x'.repeat(201), category: 'VISIT', content: 'Valid.' },
      }),
    )
    const result = await buildIntakeVenuePackageCandidate({
      db: client as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(result).toMatchObject({
      ready: false,
      payload: null,
      issues: [expect.objectContaining({ code: 'PACKAGE_FIELD_INVALID' })],
    })
  })

  it('requires one exact immutable bootstrap evidence binding without leaking its values', async () => {
    const content = {
      kind: 'knowledge',
      value: { title: 'Sensitive title', category: 'VISIT', content: 'Sensitive content.' },
    }
    const exact = bootstrapRun(content)
    for (const run of [
      bootstrapRun(content, {
        evidence: [
          {
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            locator: 'onboarding:structured-bootstrap:v1',
            normalizedHash: 'b'.repeat(64),
            confidence: 1,
          },
        ],
      }),
      bootstrapRun(content, {
        evidence: [
          {
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            locator: 'onboarding:structured-bootstrap:v1',
            normalizedHash: exact.submissionInputHash,
            confidence: 1,
          },
          {
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            locator: 'onboarding:structured-bootstrap:v1',
            normalizedHash: exact.submissionInputHash,
            confidence: 1,
          },
        ],
      }),
    ]) {
      await expect(
        buildIntakeVenuePackageCandidate({
          db: db(run) as never,
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          runId: 'run-a',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_EVIDENCE',
        message: 'Stored onboarding evidence is invalid',
      })
    }
  })

  it('fails closed when the stored bootstrap proposal or venue shell no longer matches its hash', async () => {
    const content = {
      kind: 'knowledge',
      value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
    }
    const exact = bootstrapRun(content)
    for (const run of [
      {
        ...exact,
        structuredBootstrap: {
          version: 1,
          content: {
            kind: 'knowledge',
            value: { title: 'Hours', category: 'VISIT', content: 'Changed content.' },
          },
        },
      },
      { ...exact, venue: { ...exact.venue, name: 'Changed venue' } },
    ]) {
      await expect(
        buildIntakeVenuePackageCandidate({
          db: db(run) as never,
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          runId: 'run-a',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_EVIDENCE',
        message: 'Stored onboarding source is inconsistent',
      })
    }
  })

  it('does not invent coordinates for a location-aware bootstrap place', async () => {
    const content = {
      kind: 'place' as const,
      value: { name: 'Front entrance', type: 'ENTRANCE', shortDescription: 'Main doors.' },
    }
    const venue = {
      name: 'Museum',
      slug: 'museum',
      guideMode: 'location_aware' as const,
      defaultCenterLat: 41.88,
      defaultCenterLng: -87.63,
    }
    const submissionInputHash = onboardingBootstrapInputHash({
      venue,
      proposal: { version: 1, content },
    })
    const run = bootstrapRun(content, {
      venue: { ...venue, category: null },
      submissionInputHash,
      evidence: [
        {
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          locator: 'onboarding:structured-bootstrap:v1',
          normalizedHash: submissionInputHash,
          confidence: 1,
        },
      ],
    })
    const result = await buildIntakeVenuePackageCandidate({
      db: db(run) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(result).toMatchObject({
      ready: false,
      payload: null,
      issues: [
        expect.objectContaining({
          code: 'PACKAGE_FIELD_INVALID',
          path: 'places.create.0.value',
        }),
      ],
    })
    expect(JSON.stringify(result)).not.toContain('41.88')
  })

  it('enforces strict bootstrap shape and exact V3 5000/5001 UTF-16 boundaries', async () => {
    const astral = '\u{1F600}'
    const validContent = 'x'.repeat(4_998) + astral
    const valid = await buildIntakeVenuePackageCandidate({
      db: db(
        bootstrapRun({
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: validContent },
        }),
      ) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(valid).toMatchObject({ ready: true, summary: { candidateCount: 1 } })

    const tooLong = 'x'.repeat(4_999) + astral
    const invalid = await buildIntakeVenuePackageCandidate({
      db: db(
        bootstrapRun({
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: tooLong },
        }),
      ) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(invalid).toMatchObject({ ready: false, payload: null })
    expect(invalid.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PACKAGE_FIELD_INVALID' })]),
    )

    await expect(
      buildIntakeVenuePackageCandidate({
        db: db(
          bootstrapRun({
            kind: 'knowledge',
            value: {
              title: 'Sensitive title',
              category: 'VISIT',
              content: 'Sensitive content.',
              privateText: 'must not survive',
            },
          }),
        ) as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE',
      message: 'Stored onboarding information is invalid',
    })
  })

  it('maps only evidence-verified public interview text and blocks discrepancies', async () => {
    const publicText = 'Open nine to five.'
    const normalizedHash = createHash('sha256')
      .update(`operations.hours:PUBLIC_CANDIDATE:${publicText}`)
      .digest('hex')
    const reviewRun = {
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Interview',
      interviewRole: 'OPERATIONS',
      interviewConsentTextHash: consentHash,
      interviewPublicAnswers: [
        {
          questionId: 'operations.hours',
          text: publicText,
          privacy: 'PUBLIC_CANDIDATE',
          confidence: 0.8,
        },
      ],
      interviewAnswerManifest: [
        {
          questionId: 'operations.hours',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: false,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash,
        },
        {
          questionId: 'operations.closures',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: true,
          redacted: false,
          uncertain: true,
          confidence: 0.5,
          normalizedHash: null,
        },
        {
          questionId: 'operations.internal-procedures',
          privacy: 'PRIVATE',
          skipped: false,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: 'b'.repeat(64),
        },
      ],
      evidence: [
        {
          id: 'e1',
          sourceKind: 'INTERVIEW',
          locator: 'interview:question:operations.hours:PUBLIC_CANDIDATE',
          normalizedHash,
          confidence: 0.8,
          capturedAt: new Date(),
        },
        {
          id: 'e2',
          sourceKind: 'INTERVIEW',
          locator: 'interview:question:operations.internal-procedures:PRIVATE',
          normalizedHash: 'b'.repeat(64),
          confidence: 0.8,
          capturedAt: new Date(),
        },
      ],
      events: [],
      createdAt: new Date(),
    }
    const client = db(
      {
        id: 'run-a',
        sourceKind: 'INTERVIEW',
        status: 'AWAITING_REVIEW',
        structuredBootstrap: null,
        packageHandoff: null,
        interviewClarificationResolutions: [],
      },
      reviewRun,
    )
    const result = await buildIntakeVenuePackageCandidate({
      db: client as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(result.ready).toBe(false)
    expect(result.payload).toBeNull()
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INTERVIEW_DISCREPANCY',
          path: 'venue.operations.closures',
        }),
      ]),
    )
    expect(JSON.stringify(result)).not.toContain('b'.repeat(64))
    expect(JSON.stringify(result)).not.toContain('internal-procedures')
  })

  it('builds a public-only interview candidate after every discrepancy is resolved', async () => {
    const answers = [
      ['operations.hours', 'Open nine to five.'],
      ['operations.closures', "Closed on New Year's Day."],
    ] as const
    const manifests = answers.map(([questionId, text]) => ({
      questionId,
      privacy: 'PUBLIC_CANDIDATE',
      skipped: false,
      redacted: false,
      uncertain: false,
      confidence: 0.8,
      normalizedHash: createHash('sha256')
        .update(`${questionId}:PUBLIC_CANDIDATE:${text}`)
        .digest('hex'),
    }))
    const reviewRun = {
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Interview',
      interviewRole: 'OPERATIONS',
      interviewConsentTextHash: consentHash,
      interviewPublicAnswers: answers.map(([questionId, text]) => ({
        questionId,
        text,
        privacy: 'PUBLIC_CANDIDATE',
        confidence: 0.8,
      })),
      interviewAnswerManifest: [
        ...manifests,
        {
          questionId: 'operations.internal-procedures',
          privacy: 'PRIVATE',
          skipped: false,
          redacted: true,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: null,
        },
      ],
      evidence: manifests.map((answer, index) => ({
        id: `e${index}`,
        sourceKind: 'INTERVIEW',
        locator: `interview:question:${answer.questionId}:PUBLIC_CANDIDATE`,
        normalizedHash: answer.normalizedHash,
        confidence: 0.8,
        capturedAt: new Date(),
      })),
      events: [],
      createdAt: new Date(),
    }
    const client = db(
      {
        id: 'run-a',
        sourceKind: 'INTERVIEW',
        status: 'AWAITING_REVIEW',
        structuredBootstrap: null,
        packageHandoff: null,
        interviewClarificationResolutions: [],
      },
      reviewRun,
    )
    const result = await buildIntakeVenuePackageCandidate({
      db: client as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(result).toMatchObject({
      ready: true,
      candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      summary: { candidateCount: 2, issueCount: 0 },
    })
    expect(result.payload?.knowledgeEntries.create).toEqual([
      expect.objectContaining({
        provenance: expect.objectContaining({
          sourceName: 'Staff interview: venue.operations.hours',
          contentOrigin: 'HUMAN_AUTHORED',
        }),
        value: expect.objectContaining({ category: 'HOURS', content: 'Open nine to five.' }),
      }),
      expect.objectContaining({
        provenance: expect.objectContaining({
          sourceName: 'Staff interview: venue.operations.closures',
        }),
        value: expect.objectContaining({
          category: 'CLOSURES',
          content: "Closed on New Year's Day.",
        }),
      }),
    ])
    expect(JSON.stringify(result)).not.toContain('internal-procedures')
  })

  it('freezes interview candidate order across stored row permutations', async () => {
    const entries = [
      ['operations.closures', "Closed on New Year's Day."],
      ['operations.hours', 'Open nine to five.'],
    ] as const
    const scopeRun = {
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      structuredBootstrap: null,
      packageHandoff: null,
      evidence: [],
      interviewClarificationResolutions: [],
    }
    const first = await buildIntakeVenuePackageCandidate({
      db: db(scopeRun, interviewRun(entries)) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    const permuted = await buildIntakeVenuePackageCandidate({
      db: db(scopeRun, interviewRun(entries, true)) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(permuted.payload).toEqual(first.payload)
    expect(permuted.candidateHash).toBe(first.candidateHash)
    expect(first.payload?.knowledgeEntries.create.map((entry) => entry.value.category)).toEqual([
      'HOURS',
      'CLOSURES',
    ])
  })

  it('changes both item identity and candidate hash when reviewed public text changes', async () => {
    const scopeRun = {
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      structuredBootstrap: null,
      packageHandoff: null,
      evidence: [],
      interviewClarificationResolutions: [],
    }
    const first = await buildIntakeVenuePackageCandidate({
      db: db(
        scopeRun,
        interviewRun([
          ['operations.hours', 'Open nine to five.'],
          ['operations.closures', 'Closed on holidays.'],
        ]),
      ) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    const changed = await buildIntakeVenuePackageCandidate({
      db: db(
        scopeRun,
        interviewRun([
          ['operations.hours', 'Open ten to six.'],
          ['operations.closures', 'Closed on holidays.'],
        ]),
      ) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(changed.payload?.knowledgeEntries.create[0]?.itemKey).not.toBe(
      first.payload?.knowledgeEntries.create[0]?.itemKey,
    )
    expect(changed.candidateHash).not.toBe(first.candidateHash)
  })

  it('uses an exact answered-question amendment to resolve one interview discrepancy', async () => {
    const rawReview = interviewRun([['operations.hours', 'Open nine to five.']])
    const projectedReview = await getIntakeProposalReview({
      db: db(rawReview) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    const clarificationReview = buildInterviewClarificationReview({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      review: projectedReview,
    })
    const clarification = clarificationReview.clarifications.find(
      ({ fieldPath }) => fieldPath === 'venue.operations.closures',
    )!
    const answer = "Closed on New Year's Day."
    const amendedPublicText = 'Closed on New Year’s Day.'
    const answeredAt = new Date('2026-08-29T22:00:00.000Z')
    const scopeRun = {
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      structuredBootstrap: null,
      packageHandoff: null,
      evidence: [],
      interviewClarificationResolutions: [
        {
          id: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
          reviewHash: clarificationReview.reviewHash,
          clarificationId: clarification.clarificationId,
          fieldPath: clarification.fieldPath,
          answerHash: createHash('sha256').update(answer).digest('hex'),
          answeredAt,
          kind: 'REPLACE_PUBLIC_TEXT',
          amendedPublicText,
          amendedTextHash: createHash('sha256').update(amendedPublicText).digest('hex'),
          question: {
            operationId: clarification.operationId,
            status: 'ANSWERED',
            answer,
            answeredAt,
          },
        },
      ],
    }

    const result = await buildIntakeVenuePackageCandidate({
      db: db(scopeRun, rawReview) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(result).toMatchObject({
      ready: true,
      summary: { candidateCount: 2, issueCount: 0 },
    })
    expect(result.payload?.knowledgeEntries.create[1]).toMatchObject({
      provenance: { sourceName: 'Reviewed interview amendment: venue.operations.closures' },
      value: { category: 'CLOSURES', content: amendedPublicText },
    })
  })

  it('fails closed instead of applying stale interview resolution evidence', async () => {
    const rawReview = interviewRun([['operations.hours', 'Open nine to five.']])
    const answeredAt = new Date('2026-08-29T22:00:00.000Z')
    const scopeRun = {
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      structuredBootstrap: null,
      packageHandoff: null,
      evidence: [],
      interviewClarificationResolutions: [
        {
          id: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
          reviewHash: 'f'.repeat(64),
          clarificationId: 'stale-clarification',
          fieldPath: 'venue.operations.closures',
          answerHash: 'e'.repeat(64),
          answeredAt,
          kind: 'EXCLUDE_FIELD',
          amendedPublicText: null,
          amendedTextHash: null,
          question: {
            operationId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
            status: 'ANSWERED',
            answer: 'Exclude it.',
            answeredAt,
          },
        },
      ],
    }

    const result = await buildIntakeVenuePackageCandidate({
      db: db(scopeRun, rawReview) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(result.ready).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INTERVIEW_RESOLUTION_INVALID',
          path: 'venue.operations.closures',
        }),
      ]),
    )
  })

  it('exact-binds tenant, venue, run and rejects unsupported source as not found', async () => {
    const client = db(null)
    await expect(
      buildIntakeVenuePackageCandidate({
        db: client as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(client.intakeRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'run-a',
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          sourceKind: { in: ['STRUCTURED_BOOTSTRAP', 'INTERVIEW'] },
        },
      }),
    )
  })
})
