import type {
  ClaimAnnotation,
  MeaningAssessment,
  NativeSalesAction,
  SalesWorkflowView,
} from '../../packages/api/src/prospect-sales-contract'

/** Explicit AI-authored SYNTHETIC test judgments. These do not assert human actions. */
export function meaningTextFixture(
  venueName: string,
  mode: 'good' | 'unsupported' | 'reply' = 'good',
) {
  const subject =
    mode === 'reply' ? 'Could we discuss one room?' : 'Could a small visitor guide be useful?'
  const body =
    mode === 'reply'
      ? 'Hi,\n\nWe could discuss starting with one room and using material you choose. That would give us a small, specific setting to talk through, rather than assuming a larger rollout is needed.\n\nWhich room would you most like to explore first, and what would you want a visitor to understand there?\n\nThanks,\nTom'
      : `Hi,\n\n${mode === 'unsupported' ? 'Your Moon Gem Gallery exhibit costs $25, and I visited it yesterday.' : venueName + '.'}\n\nWould it be useful to explore a small question-based guide for one room or a few objects? It could use material you choose and stay focused on that part of a visit.\n\nWould a short conversation about that idea make sense?\n\nThanks,\nTom`
  return { subject, body }
}

export function meaningAnnotations(view: SalesWorkflowView) {
  const draft = view.draft!,
    review = view.claimReview!
  const reply = review.questions.length > 0
  const annotations: ClaimAnnotation[] = [],
    assessments: MeaningAssessment[] = []
  let index = 0
  for (const section of ['subject', 'body'] as const) {
    const text = section === 'subject' ? draft.subject : draft.body
    let offset = 0
    for (const quote of text.split('\n\n')) {
      const start = offset,
        end = start + Array.from(quote).length
      offset = end + 2
      if (!quote.trim()) continue
      const courtesy = ['Hi,', 'Hello,', 'Thanks,\nTom'].includes(quote)
      const factual =
        !reply &&
        section === 'body' &&
        !courtesy &&
        (quote.endsWith('yesterday.') ||
          quote === review.sources.find((claim) => claim.claim_id === 'F-VENUE')!.text + '.')
      const category: ClaimAnnotation['category'] = courtesy
        ? 'NONFACTUAL'
        : factual
          ? 'SOURCE FACT'
          : reply
            ? 'TASK CONSTRAINT'
            : 'SALES HYPOTHESIS'
      const ids = courtesy
        ? []
        : factual
          ? ['F-VENUE']
          : reply
            ? ['H-RESPONSE']
            : quote.startsWith('Would a short conversation')
              ? ['H-ASK']
              : ['H-SCOPE']
      const reason = courtesy
        ? 'An ordinary greeting or closing uses only the task-supplied sender name and asserts no venue fact.'
        : factual && quote.includes('Moon Gem')
          ? 'SYNTHETIC adversarial assertion: exhibit, price and completed visit have no supporting source; the intentionally wrong supported verdict must be held.'
          : factual
            ? 'The exact venue identity is reproduced from the bound F-VENUE source; it does not assert a completed visit or exhibit details.'
            : reply
              ? 'This is a conditional discussion and question grounded in the operator H-RESPONSE direction, not independent verification or a delivery commitment.'
              : 'This asks about a possible limited guide or conversation; it does not assert an agreement, a proven outcome or a venue need.'
      const annotation_id = `claim-${++index}`
      annotations.push({
        annotation_id,
        section,
        start,
        end,
        quote,
        category,
        claim_ids: ids,
        reason,
        answers:
          reply && section === 'body' && !courtesy
            ? review.questions.map((question) => question.question_id)
            : [],
      })
      assessments.push({
        annotation_id,
        verdict: courtesy ? 'nonfactual' : factual || reply ? 'supported' : 'hypothetical',
        reason,
      })
    }
  }
  return { annotations, assessments }
}

export function meaningAction(
  view: SalesWorkflowView,
  identity = 'GPT-6 Astra Pro — SYNTHETIC local acceptance assessment',
): Extract<NativeSalesAction, { action: 'meaning' }> {
  const draft = view.draft!,
    review = view.claimReview!
  if (!review.bindingHash || review.stale)
    throw new Error('A current exact native meaning binding is required')
  const { annotations, assessments } = meaningAnnotations(view)
  return {
    action: 'meaning',
    input: {
      venueId: view.venueId,
      draftId: draft.id,
      contentHash: draft.contentHash,
      expectedSnapshotHash: view.snapshotHash,
      expectedBindingHash: review.bindingHash,
      expectedMeaningReviewId: review.current?.id ?? null,
      reviewer: { kind: 'model', identity },
      annotations,
      assessments,
      languageUses: [],
      unsupportedClaims: [],
      answers: review.questions.map((question) => {
        const annotation = annotations.find((entry) =>
          entry.answers.includes(question.question_id),
        )!
        return {
          question_id: question.question_id,
          verdict: 'answers',
          quote: annotation.quote,
          reason: annotation.reason,
        }
      }),
    },
  }
}
