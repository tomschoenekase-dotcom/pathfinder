import { createHash } from 'node:crypto'

export const MAX_SYNTHETIC_RESPONSE_BYTES = 32 * 1024

function normalize(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ')
}

function includesTerm(normalizedResponse, term) {
  const normalizedTerm = normalize(term)
  return normalizedTerm.length > 0 && ` ${normalizedResponse} `.includes(` ${normalizedTerm} `)
}

export function assessSyntheticConversationResponse(replay, response) {
  if (typeof response !== 'string' || response.trim().length === 0)
    throw new Error('synthetic-response-required')
  const responseBytes = Buffer.byteLength(response, 'utf8')
  if (responseBytes > MAX_SYNTHETIC_RESPONSE_BYTES) throw new Error('synthetic-response-too-large')
  if (!Array.isArray(replay?.assertions) || replay.assertions.length === 0)
    throw new Error('synthetic-replay-assertions-required')

  const normalizedResponse = normalize(response)
  const assertions = replay.assertions.map((assertion) => {
    const matchedTerm = assertion.matchTerms.find((term) => includesTerm(normalizedResponse, term))
    const matched = Boolean(matchedTerm)
    return {
      id: assertion.id,
      fact: assertion.fact,
      required: assertion.required,
      matched,
      matchedTerm: matchedTerm ?? null,
      evidence: assertion.evidence,
      explanation: matched
        ? `The response contains the fixture-owned match term for ${assertion.fact}.`
        : `The response does not contain any fixture-owned match term for ${assertion.fact}.`,
    }
  })
  const required = assertions.filter((assertion) => assertion.required)
  const matched = required.filter((assertion) => assertion.matched).length
  const verdict = matched === required.length ? 'pass' : 'fail'

  return {
    schemaVersion: 1,
    synthetic: true,
    scenarioId: replay.scenarioId,
    verdict,
    response: {
      sha256: createHash('sha256').update(response, 'utf8').digest('hex'),
      bytes: responseBytes,
      retained: false,
    },
    summary: {
      required: required.length,
      matched,
      missing: required.length - matched,
    },
    assertions,
    grounding: {
      explained: true,
      unsupportedClaimsEvaluated: false,
      limitation:
        'This deterministic lexical check proves only fixture-owned required-fact coverage. It does not judge arbitrary unsupported claims, answer usefulness, or provider behavior.',
    },
    providerDispatch: false,
  }
}
