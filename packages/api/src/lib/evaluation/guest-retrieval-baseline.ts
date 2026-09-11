import {
  retrieveGuestKnowledge,
  type GuestKnowledgeReader,
  type GuestKnowledgeRetrievalTrace,
} from '../guest-knowledge-retrieval'

export const GUEST_RETRIEVAL_TEST_TARGET_KIND = 'ENGINEERING_TEST_TARGET_NOT_SLO' as const

export type GuestRetrievalBaselineCase = {
  name: string
  query: string
  expectedSourceId: string
}

export async function runGuestRetrievalBaseline(input: {
  reader: GuestKnowledgeReader
  tenantId: string
  venueId: string
  cases: GuestRetrievalBaselineCase[]
  intendedTestTargetMs: number
}) {
  const measurements: Array<{
    name: string
    expectedSourceId: string
    foundExpectedSource: boolean
    retrievalMs: number
    trace: GuestKnowledgeRetrievalTrace
  }> = []
  for (const scenario of input.cases) {
    const result = await retrieveGuestKnowledge({
      reader: input.reader,
      query: scenario.query,
      tenantId: input.tenantId,
      venueId: input.venueId,
      includeSecondLayer: false,
      queryEmbedding: null,
    })
    measurements.push({
      name: scenario.name,
      expectedSourceId: scenario.expectedSourceId,
      foundExpectedSource: result.trace.retrievedSourceIds.includes(scenario.expectedSourceId),
      retrievalMs: result.trace.retrievalMs,
      trace: result.trace,
    })
  }
  return {
    target: {
      kind: GUEST_RETRIEVAL_TEST_TARGET_KIND,
      intendedTestTargetMs: input.intendedTestTargetMs,
    },
    measurements,
    comparison: {
      allExpectedSourcesFound: measurements.every((item) => item.foundExpectedSource),
      allWithinIntendedTestTarget: measurements.every(
        (item) => item.retrievalMs <= input.intendedTestTargetMs,
      ),
    },
    provider: {
      called: false as const,
      latencyMs: null,
      estimatedCostUsd: null,
      invoiceCostUsd: null,
    },
  }
}
