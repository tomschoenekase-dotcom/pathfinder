import { describe, expect, it } from 'vitest'

import {
  STAFF_INTERVIEW_CONSENT_TEXT,
  STAFF_INTERVIEW_QUESTION_SETS,
  StaffInterviewRole,
  StaffInterviewSubmission,
} from './staff-interview'

describe('staff interview contracts', () => {
  it('provides distinct structured question sets for every supported staff role', () => {
    expect(Object.keys(STAFF_INTERVIEW_QUESTION_SETS).sort()).toEqual(
      [...StaffInterviewRole.options].sort(),
    )
    const ids = Object.values(STAFF_INTERVIEW_QUESTION_SETS).flatMap((questions) =>
      questions.map((question) => question.id),
    )
    expect(new Set(ids).size).toBe(ids.length)
    for (const [role, questions] of Object.entries(STAFF_INTERVIEW_QUESTION_SETS)) {
      expect(questions.length).toBeGreaterThanOrEqual(3)
      expect(questions.every((question) => question.role === role)).toBe(true)
      expect(questions.some((question) => question.defaultPrivacy !== 'PUBLIC_CANDIDATE')).toBe(
        true,
      )
    }
  })

  it('requires the exact consent text when consent is granted', () => {
    expect(
      StaffInterviewSubmission.safeParse({
        role: 'CONTENT',
        consentToUse: true,
        answers: [],
      }).success,
    ).toBe(false)
    expect(
      StaffInterviewSubmission.safeParse({
        role: 'CONTENT',
        consentToUse: true,
        acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
        answers: [],
      }).success,
    ).toBe(true)
  })

  it.each(['recording', 'recordingEnabled', 'audio', 'audioAssetId', 'video', 'videoAssetId'])(
    'structurally rejects the %s recording field',
    (field) => {
      expect(
        StaffInterviewSubmission.safeParse({
          role: 'OPERATIONS',
          consentToUse: false,
          answers: [],
          [field]: field.endsWith('Enabled') ? true : 'capture',
        }).success,
      ).toBe(false)
    },
  )
})
