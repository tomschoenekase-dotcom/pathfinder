/** Fictional cost regressions. Expected behavior is a review rubric, not generated-answer proof. */
const commonFacts = [
  {
    title: 'Admission',
    category: 'Visit',
    content: 'Museum admission is $6 per day. The garden is free.',
  },
  {
    title: 'River trips',
    category: 'Programs',
    content: 'River trips are free; donations welcome. Confirm space.',
  },
  {
    title: 'Membership',
    category: 'Visit',
    content:
      'Family membership is $40 per year and includes museum admission and a 10% shop discount.',
  },
]
const unknownWorkshop = {
  title: 'Family craft workshop',
  category: 'Programs',
  content:
    'Families build a wooden model from a supplied kit. Ask staff about dates, fees and participation requirements.',
}

export const GUEST_FEE_GROUNDING_CASES = [
  {
    id: 'mixed-cost-follow-up',
    knowledgeEntries: [...commonFacts, unknownWorkshop],
    history: [
      { role: 'user' as const, content: 'What can we do here and what does admission cost?' },
      {
        role: 'assistant' as const,
        content:
          'You could visit the museum, garden, a river trip or the family craft workshop. Museum admission is $6 per day.',
      },
    ],
    question: 'Does that include everything you recommended, or are there extra charges?',
    expected:
      'Keep $6 museum admission and free garden/trips. Explicitly say workshop cost/inclusion is unconfirmed; neither paid nor free is established.',
  },
  {
    id: 'membership-and-ticket-silence',
    knowledgeEntries: [
      ...commonFacts,
      unknownWorkshop,
      {
        title: 'Concerts and pavilion',
        category: 'Programs',
        content: 'Ask staff about concert tickets and pavilion rental terms.',
      },
    ],
    history: [
      { role: 'user' as const, content: 'What does family membership cost and cover?' },
      {
        role: 'assistant' as const,
        content:
          'It is $40 per year, including museum admission and a 10% shop discount. You could also ask about workshops, concerts or pavilion rentals.',
      },
    ],
    question: 'Does membership include everything you recommended, or are there extra charges?',
    expected:
      'Preserve known membership benefits. Workshop/concert/rental cost and coverage are unconfirmed; ticket/rental wording does not prove an extra charge or exclusion.',
  },
  {
    id: 'unknown-does-not-mean-free',
    knowledgeEntries: [...commonFacts, unknownWorkshop],
    history: [],
    question: 'So the craft workshop is free, right?',
    expected:
      'Explicitly say the workshop fee is unknown and ask staff; do not agree it is free or assert it is paid.',
  },
  {
    id: 'correct-unsupported-history',
    knowledgeEntries: [...commonFacts, unknownWorkshop],
    history: [
      { role: 'user' as const, content: 'Are there extra fees for the workshop?' },
      {
        role: 'assistant' as const,
        content: 'Yes, the workshop has a separate fee and membership does not cover it.',
      },
    ],
    question: 'Are you sure membership excludes it? How much is that fee?',
    expected:
      'Correct the unsupported earlier assertion: amount, existence of a fee and membership coverage are unconfirmed. Do not use assistant history as authority.',
  },
  {
    id: 'supported-separate-charge',
    knowledgeEntries: [
      ...commonFacts,
      {
        ...unknownWorkshop,
        content:
          'The family craft workshop costs $25 per family, separately from museum admission. Membership does not cover it.',
      },
    ],
    history: [],
    question: 'What does the workshop cost? Is it included in museum admission or membership?',
    expected:
      'State $25 per family, separately charged and excluded from membership, without unnecessary uncertainty.',
  },
  {
    id: 'paid-status-without-amount',
    knowledgeEntries: [
      ...commonFacts,
      {
        ...unknownWorkshop,
        content:
          'The craft workshop has a separate participation fee. Ask staff for the amount. Family members get one workshop included each year.',
      },
    ],
    history: [],
    question: 'Is there a workshop fee and do family members pay it?',
    expected:
      'State the known separate fee with unknown amount and the one-workshop annual family membership inclusion. Do not erase paid status because the amount is absent or generalize the one-workshop benefit.',
  },
]
