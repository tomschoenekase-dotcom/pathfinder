import { describe, expect, it } from 'vitest'

import { workAnchorTarget } from './OperationsAnchorRedirect'

describe('legacy operations deep links', () => {
  it('opens the actual work section for existing question, approval, run, and job anchors', () => {
    for (const anchor of [
      'needs-you-heading',
      'approval-attention-heading',
      'ai-workforce',
      'job-attention-heading',
      'customer-alerts',
    ]) {
      expect(workAnchorTarget(`#${anchor}`)).toBe(`/admin/operations?view=work#${anchor}`)
    }
  })

  it('leaves unrelated anchors alone', () => {
    expect(workAnchorTarget('#admin-main-content')).toBeNull()
    expect(workAnchorTarget('#incident-control')).toBeNull()
  })
})
