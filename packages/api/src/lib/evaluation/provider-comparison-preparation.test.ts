import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { PROVIDER_COMPARISON_CASES } from './provider-comparison-corpus'
import {
  PROVIDER_SOURCE_CLAIM_CASES,
  hashPreparedSourceClaimCase,
  scorePreparedSourceClaimOutput,
} from './provider-source-claim-corpus'
import {
  buildProviderComparisonPreparation,
  validateProviderComparisonObservations,
} from './provider-comparison-preparation'

describe('provider comparison preparation', () => {
  it('reuses one frozen corpus across current routes without fabricating observations', () => {
    const preparation = buildProviderComparisonPreparation()
    expect(preparation.cases).toBe(PROVIDER_COMPARISON_CASES)
    expect(preparation.routes.map(({ routeKey }) => routeKey)).toEqual([
      'guest-chat',
      'guest-chat-openai',
    ])
    expect(
      preparation.routes.every(({ observation }) => observation.status === 'UNAVAILABLE'),
    ).toBe(true)
    expect(
      preparation.routes.every(({ observation }) =>
        Object.values(observation.metrics).every((value) => value === null),
      ),
    ).toBe(true)
    expect(preparation.recommendation).toBeNull()
    expect(preparation.modalityPreparation).toEqual({
      researchExtraction: {
        preparationStatus: 'PASS',
        modelQuality: 'UNKNOWN',
        corpusHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        cases: PROVIDER_SOURCE_CLAIM_CASES,
        routes: [
          expect.objectContaining({ routeKey: 'company-brain-retrieval-evaluation' }),
          expect.objectContaining({ routeKey: 'answer-analysis' }),
        ],
        observation: null,
        limitation: expect.stringContaining('no provider'),
      },
      realtimeVoice: { status: 'UNAVAILABLE', reason: expect.stringContaining('P11') },
      video: { status: 'UNAVAILABLE', reason: expect.stringContaining('P10') },
    })
    const outputPath = process.env.PROVIDER_COMPARISON_PREPARATION_OUTPUT
    if (outputPath) {
      const source = preparation.modalityPreparation.researchExtraction
      writeFileSync(
        outputPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            recordedDate: '2026-09-08',
            reproducer:
              "$env:PROVIDER_COMPARISON_PREPARATION_OUTPUT='C:\\Users\\tomsc\\Downloads\\PathFinder-evaluation-tenant-scope-integration\\docs\\evidence\\provider-comparison-preparation-2026-09-08.json'; $env:PROVIDER_COMPARISON_REPO_REVISION=(git rev-parse HEAD); pnpm --dir packages/api exec vitest run src/lib/evaluation/provider-comparison-preparation.test.ts; Remove-Item Env:PROVIDER_COMPARISON_PREPARATION_OUTPUT; Remove-Item Env:PROVIDER_COMPARISON_REPO_REVISION",
            preparationStatus: 'PREPARED_UNEXECUTED',
            validationCommand:
              'pnpm --dir packages/api exec vitest run src/lib/evaluation/provider-comparison-preparation.test.ts',
            providerDispatched: false,
            provenance: {
              repoRevision: process.env.PROVIDER_COMPARISON_REPO_REVISION ?? 'UNKNOWN',
              sourceFilesSha256: Object.fromEntries(
                [
                  'src/lib/evaluation/provider-comparison-corpus.ts',
                  'src/lib/evaluation/provider-comparison-preparation.ts',
                  'src/lib/evaluation/provider-source-claim-corpus.ts',
                ].map((path) => [
                  `packages/api/${path}`,
                  createHash('sha256').update(readFileSync(path)).digest('hex'),
                ]),
              ),
            },
            textComparison: {
              corpusHash: preparation.corpusHash,
              routes: preparation.routes,
              recommendation: null,
            },
            sourceClaimComparison: {
              corpusHash: source.corpusHash,
              routes: source.routes,
              modelQuality: 'UNKNOWN',
              observation: null,
              outputSchema: {
                entityId: 'string',
                claims: [{ fieldPath: 'requested field string', value: 'atomic string value' }],
                disposition: ['EXTRACT', 'ESCALATE'],
                additionalProperties: false,
              },
              modelInputs: source.cases.map(
                ({ caseId, caseHash, sourceHash, evaluationAsOf, input }) => ({
                  caseId,
                  caseHash,
                  sourceHash,
                  evaluationAsOf,
                  input,
                }),
              ),
              graderExpected: source.cases.map(({ caseId, caseHash, rubric }) => ({
                caseId,
                caseHash,
                rubric,
              })),
            },
            modalities: {
              realtimeVoice: preparation.modalityPreparation.realtimeVoice,
              video: preparation.modalityPreparation.video,
            },
            limits: [
              'Synthetic preparation validation is not model quality evidence.',
              'No provider, credential, billing, or live route was accessed.',
              'Configured prices are registry estimates, not observed or invoiced cost.',
              'An executor must not send graderExpected to a provider.',
            ],
          },
          null,
          2,
        )}\n`,
      )
    }
  })

  it('rejects structurally incomplete corpora, scoring, and duplicate routes', () => {
    const observation = buildProviderComparisonPreparation().routes[0]!.observation
    expect(() =>
      validateProviderComparisonObservations([
        { ...observation, caseIds: observation.caseIds.slice(1) },
      ]),
    ).toThrow('frozen corpus')
    expect(() =>
      validateProviderComparisonObservations([{ ...observation, status: 'OBSERVED' }]),
    ).toThrow('every metric')
    expect(() => validateProviderComparisonObservations([observation, observation])).toThrow(
      'unique route keys',
    )
    expect(() =>
      validateProviderComparisonObservations([
        {
          ...observation,
          status: 'OBSERVED',
          metrics: Object.fromEntries(Object.keys(observation.metrics).map((key) => [key, 1])),
          latencyMs: Number.POSITIVE_INFINITY,
        },
      ]),
    ).toThrow()
    expect(() =>
      validateProviderComparisonObservations([{ ...observation, latencyMs: 1 }]),
    ).toThrow('Unavailable observations')
    expect(() =>
      validateProviderComparisonObservations([
        { ...observation, caseHashes: observation.caseHashes.map(() => '0'.repeat(64)) },
      ]),
    ).toThrow('case hashes')
  })

  it('executes synthetic source-claim criteria without turning them into model observations', () => {
    expect(
      scorePreparedSourceClaimOutput('source-claim-hours-current', {
        entityId: 'gallery-north',
        claims: [{ fieldPath: 'hours.current', value: '10:00-16:00' }],
        disposition: 'EXTRACT',
      }),
    ).toMatchObject({ passed: true, validOutput: true })
    expect(scorePreparedSourceClaimOutput('source-claim-malformed-output', '{bad json')).toEqual({
      validOutput: false,
      passed: false,
    })
    expect(
      scorePreparedSourceClaimOutput('source-claim-similar-entities', {
        entityId: 'gallery-east',
        claims: [{ fieldPath: 'capacity', value: '145' }],
        disposition: 'EXTRACT',
      }).passed,
    ).toBe(false)
    expect(
      scorePreparedSourceClaimOutput('source-claim-similar-entities', {
        entityId: 'gallery-east',
        claims: [
          { fieldPath: 'capacity', value: '45' },
          { fieldPath: 'capacity', value: '90' },
        ],
        disposition: 'EXTRACT',
      }).passed,
    ).toBe(false)
    const expiry = PROVIDER_SOURCE_CLAIM_CASES.find(
      ({ caseId }) => caseId === 'source-claim-expired-update',
    )!
    expect(expiry.evaluationAsOf).toBe('2026-09-08T12:00:00.000Z')
    expect(expiry.input.targetEntityId).toBe('arrival-update')
    expect(
      hashPreparedSourceClaimCase({
        caseId: expiry.caseId,
        evaluationAsOf: expiry.evaluationAsOf,
        input: expiry.input,
        rubric: { ...expiry.rubric, disposition: 'EXTRACT' },
      }),
    ).not.toBe(expiry.caseHash)
  })
})
