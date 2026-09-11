import { describe, expect, it } from 'vitest'

import { redactCommonIdentifiers } from './common-identifier-redaction'

describe('redactCommonIdentifiers', () => {
  it('removes common contact identifiers while retaining ordinary venue questions', () => {
    expect(
      redactCommonIdentifiers(
        'Where is the north gallery? Email jane@example.test, call 312-555-0101, or visit https://example.test/help.',
      ),
    ).toBe(
      'Where is the north gallery? Email [email removed], call [phone removed], or visit [link removed]',
    )
  })

  it('documents the bounded nature of the filter by leaving names untouched', () => {
    expect(redactCommonIdentifiers('Ask Maria at the welcome desk.')).toBe(
      'Ask Maria at the welcome desk.',
    )
  })
})
