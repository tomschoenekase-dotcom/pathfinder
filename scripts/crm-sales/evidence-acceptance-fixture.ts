import type {
  NativeSalesAction,
  SalesWorkflowView,
} from '../../packages/api/src/prospect-sales-contract'

/** Explicit fixture judgments by this model, not a runtime classifier or human action. */
export const evidenceDraft = (venueName: string, unsupported = false) => ({
  subject: 'Could a small visitor guide be useful?',
  body: `Hi,\n\n${unsupported ? 'Your Moon Gem Gallery exhibit costs $25, and I visited it yesterday.' : venueName + '.'}\n\nWould it be useful to explore a small question-based guide for one room or a few objects? It could use material you choose and stay focused on that part of a visit.\n\nWould a short conversation about that idea make sense?\n\nThanks,\nTom`,
})

export function evidenceMeaningAction(
  view: SalesWorkflowView,
): Extract<NativeSalesAction, { action: 'meaning' }> {
  const draft = view.draft!,
    review = view.claimReview!
  if (!review.bindingHash || review.stale) throw new Error('Current exact meaning binding required')
  const annotations: Extract<NativeSalesAction, { action: 'meaning' }>['input']['annotations'] = []
  const assessments: Extract<NativeSalesAction, { action: 'meaning' }>['input']['assessments'] = []
  for (const section of ['subject', 'body'] as const) {
    let position = 0
    for (const quote of (section === 'subject' ? draft.subject : draft.body).split('\n\n')) {
      const start = position,
        end = start + Array.from(quote).length
      position = end + 2
      if (!quote.trim()) continue
      const courtesy = ['Hi,', 'Thanks,\nTom'].includes(quote)
      const factual = quote === view.name + '.' || quote.startsWith('Your Moon Gem Gallery')
      const category = courtesy ? 'NONFACTUAL' : factual ? 'SOURCE FACT' : 'SALES HYPOTHESIS'
      const reason = courtesy
        ? 'An ordinary greeting or closing makes no factual assertion.'
        : factual
          ? 'The native identity source supports only the venue name. An added exhibit, price or visit is deliberately unsupported in the negative fixture.'
          : 'This is a conditional proposal or question, not an agreement, venue need or promised result.'
      const annotation_id = `evidence-claim-${annotations.length + 1}`
      annotations.push({
        annotation_id,
        section,
        start,
        end,
        quote,
        category,
        claim_ids: courtesy
          ? []
          : factual
            ? ['N-IDENTITY']
            : quote.startsWith('Would a short conversation')
              ? ['H-ASK']
              : ['H-SCOPE'],
        reason,
        answers: [],
      })
      assessments.push({
        annotation_id,
        verdict: courtesy ? 'nonfactual' : factual ? 'supported' : 'hypothetical',
        reason,
      })
    }
  }
  return {
    action: 'meaning',
    input: {
      venueId: view.venueId,
      expectedSnapshotHash: view.snapshotHash,
      draftId: draft.id,
      contentHash: draft.contentHash,
      expectedBindingHash: review.bindingHash,
      expectedMeaningReviewId: review.current?.id ?? null,
      reviewer: {
        kind: 'model',
        identity: 'GPT-6 Astra Pro — explicitly synthetic technical acceptance assessment, not Tom',
      },
      annotations,
      assessments,
      languageUses: [],
      unsupportedClaims: [],
      answers: [],
    },
  }
}
