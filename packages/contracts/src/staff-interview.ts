import { z } from 'zod'

export const STAFF_INTERVIEW_CONSENT_TEXT =
  'I consent to Torchiko using these written answers to prepare a reviewable venue-content draft.'

export const StaffInterviewRole = z.enum([
  'EXECUTIVE',
  'VISITOR_SERVICES',
  'OPERATIONS',
  'ACCESSIBILITY',
  'CONTENT',
])
export type StaffInterviewRole = z.infer<typeof StaffInterviewRole>

export const StaffInterviewPrivacy = z.enum(['PUBLIC_CANDIDATE', 'INTERNAL_CONTEXT', 'PRIVATE'])
export type StaffInterviewPrivacy = z.infer<typeof StaffInterviewPrivacy>

export const StaffInterviewQuestion = z
  .object({
    id: z.string().min(1),
    role: StaffInterviewRole,
    prompt: z.string().trim().min(1).max(1_000),
    fieldPath: z.string().trim().min(1).max(500),
    required: z.boolean(),
    defaultPrivacy: StaffInterviewPrivacy,
  })
  .strict()
export type StaffInterviewQuestion = z.infer<typeof StaffInterviewQuestion>

const questions = {
  EXECUTIVE: [
    {
      id: 'executive.mission',
      role: 'EXECUTIVE',
      prompt: 'How should visitors understand the venue’s mission and purpose?',
      fieldPath: 'venue.identity.mission',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'executive.priorities',
      role: 'EXECUTIVE',
      prompt: 'Which visitor outcomes should the guide prioritize?',
      fieldPath: 'venue.guide.priorities',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'executive.internal-risks',
      role: 'EXECUTIVE',
      prompt: 'What internal sensitivities should reviewers consider?',
      fieldPath: 'internal.executiveRisks',
      required: false,
      defaultPrivacy: 'INTERNAL_CONTEXT',
    },
  ],
  VISITOR_SERVICES: [
    {
      id: 'visitor-services.arrival',
      role: 'VISITOR_SERVICES',
      prompt: 'What should a visitor know before arriving?',
      fieldPath: 'knowledge.arrival',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'visitor-services.common-questions',
      role: 'VISITOR_SERVICES',
      prompt: 'Which questions do visitors ask most often?',
      fieldPath: 'knowledge.commonQuestions',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'visitor-services.escalation',
      role: 'VISITOR_SERVICES',
      prompt: 'What internal escalation context should staff retain?',
      fieldPath: 'internal.visitorEscalation',
      required: false,
      defaultPrivacy: 'INTERNAL_CONTEXT',
    },
  ],
  OPERATIONS: [
    {
      id: 'operations.hours',
      role: 'OPERATIONS',
      prompt: 'What are the current public operating hours and date exceptions?',
      fieldPath: 'venue.operations.hours',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'operations.closures',
      role: 'OPERATIONS',
      prompt: 'Which planned closures or temporary changes may affect visitors?',
      fieldPath: 'venue.operations.closures',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'operations.internal-procedures',
      role: 'OPERATIONS',
      prompt: 'Which internal procedures should inform staff review but remain private?',
      fieldPath: 'internal.operationalProcedures',
      required: false,
      defaultPrivacy: 'PRIVATE',
    },
  ],
  ACCESSIBILITY: [
    {
      id: 'accessibility.arrival',
      role: 'ACCESSIBILITY',
      prompt: 'Describe accessible arrival routes and entrances.',
      fieldPath: 'venue.accessibility.arrival',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'accessibility.accommodations',
      role: 'ACCESSIBILITY',
      prompt: 'Which accommodations can visitors request?',
      fieldPath: 'venue.accessibility.accommodations',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'accessibility.limitations',
      role: 'ACCESSIBILITY',
      prompt: 'Which limitations need careful internal review before publication?',
      fieldPath: 'internal.accessibilityLimitations',
      required: false,
      defaultPrivacy: 'INTERNAL_CONTEXT',
    },
  ],
  CONTENT: [
    {
      id: 'content.voice',
      role: 'CONTENT',
      prompt: 'How should the guide sound to visitors?',
      fieldPath: 'venue.content.voice',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'content.terminology',
      role: 'CONTENT',
      prompt: 'Which public names and terms should the guide use consistently?',
      fieldPath: 'venue.content.terminology',
      required: true,
      defaultPrivacy: 'PUBLIC_CANDIDATE',
    },
    {
      id: 'content.embargoed',
      role: 'CONTENT',
      prompt: 'Is any draft or embargoed context relevant only to reviewers?',
      fieldPath: 'internal.embargoedContent',
      required: false,
      defaultPrivacy: 'PRIVATE',
    },
  ],
} as const satisfies Record<StaffInterviewRole, readonly StaffInterviewQuestion[]>

export const STAFF_INTERVIEW_QUESTION_SETS: Readonly<
  Record<StaffInterviewRole, readonly StaffInterviewQuestion[]>
> = {
  EXECUTIVE: questions.EXECUTIVE.map((question) => StaffInterviewQuestion.parse(question)),
  VISITOR_SERVICES: questions.VISITOR_SERVICES.map((question) =>
    StaffInterviewQuestion.parse(question),
  ),
  OPERATIONS: questions.OPERATIONS.map((question) => StaffInterviewQuestion.parse(question)),
  ACCESSIBILITY: questions.ACCESSIBILITY.map((question) => StaffInterviewQuestion.parse(question)),
  CONTENT: questions.CONTENT.map((question) => StaffInterviewQuestion.parse(question)),
}

export const StaffInterviewAnswer = z
  .object({
    questionId: z.string().min(1),
    text: z.string().trim().min(1).max(20_000).optional(),
    privacy: StaffInterviewPrivacy,
    skipped: z.boolean().default(false),
    redacted: z.boolean().default(false),
    uncertain: z.boolean().default(false),
    confidence: z.number().min(0).max(1).default(0.8),
  })
  .strict()
  .superRefine((answer, context) => {
    if (answer.skipped && answer.redacted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['redacted'],
        message: 'Choose either skipped or redacted, not both.',
      })
    }
    if (answer.skipped && answer.text !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Skipped answers cannot include text.',
      })
    }
    if (answer.redacted && answer.text !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Redacted answers cannot include text.',
      })
    }
    if (!answer.skipped && !answer.redacted && answer.text === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Include text, skip the question, or mark the answer redacted.',
      })
    }
  })
export type StaffInterviewAnswer = z.infer<typeof StaffInterviewAnswer>

export const StaffInterviewSubmission = z
  .object({
    role: StaffInterviewRole,
    consentToUse: z.boolean().default(false),
    acceptedConsentText: z.literal(STAFF_INTERVIEW_CONSENT_TEXT).optional(),
    answers: z.array(StaffInterviewAnswer).max(100),
    recording: z.never().optional(),
    recordingEnabled: z.never().optional(),
    audio: z.never().optional(),
    audioAssetId: z.never().optional(),
    video: z.never().optional(),
    videoAssetId: z.never().optional(),
  })
  .strict()
  .superRefine((submission, context) => {
    if (submission.consentToUse && !submission.acceptedConsentText) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptedConsentText'],
        message: 'The exact consent-to-use text must be accepted.',
      })
    }
    const seen = new Set<string>()
    submission.answers.forEach((answer, index) => {
      if (seen.has(answer.questionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answers', index, 'questionId'],
          message: 'Each question may be answered once.',
        })
      }
      seen.add(answer.questionId)
    })
    const questions = STAFF_INTERVIEW_QUESTION_SETS[submission.role]
    for (const question of questions) {
      if (!seen.has(question.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answers'],
          message: `Record an answer, explicit skip, or redaction for ${question.id}.`,
        })
      }
    }
  })
export type StaffInterviewSubmission = z.infer<typeof StaffInterviewSubmission>
