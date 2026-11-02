import { describe, expect, it } from 'vitest'
import { guestFocusDateBoundaryNotes } from './guest-focus-facts'

describe('closure boundary scope', () => {
  it.each([
    'The hall opens Tuesday-Sunday and is closed Mondays from November 1, 2026 to December 31, 2026.',
    'The gallery is closed on weekends starting November 1, 2026.',
    'The path is closed from November 1, 2026 through November 3, 2026.',
    'If flooding occurs, the path is closed from November 1, 2026.',
    'The hall is closed from November 1, 2026 except for booked tours.',
    'The lift is closed for maintenance every morning after November 1, 2026.',
    'The hall is not closed from November 1, 2026.',
    'The hall may be closed from November 1, 2026.',
    'The hall is closed from November 1, 2026 on Mondays.',
    'The hall is closed from November 1, 2026 for three days.',
    'The hall is closed from November 1, 2026 at noon.',
    'The hall is closed from November 1, 2026, 10am-11am daily.',
    'The hall is closed from November 1, 2026; this applies only on Mondays.',
    'The hall is closed from November 1, 2026. This applies only on Mondays.',
    'The hall is closed from November 1, 2026.\nCondition: Mondays only.',
    'The hall is closed from November 1, 2026.\nThis applies only on Mondays.',
  ])('never expands a qualified closure into an all-day indefinite closure: %s', (text) => {
    expect(guestFocusDateBoundaryNotes(text)).toEqual([])
  })
  it('retains an unqualified seasonal boundary with its exact subject', () => {
    expect(
      guestFocusDateBoundaryNotes(
        'Garden is closed for the 2026 season after October 25, 2026.',
      )[0],
    ).toContain('closed from Monday, October 26, 2026')
    expect(guestFocusDateBoundaryNotes('Lift is closed as of November 1, 2026.')[0]).toContain(
      'closed on Sunday, November 1, 2026',
    )
  })
})
