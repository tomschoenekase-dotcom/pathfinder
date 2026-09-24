import { describe, expect, it } from 'vitest'
import {
  chicagoDirectoryParams,
  chicagoSafeUrl,
  readChicagoDirectoryState,
} from './chicago-directory-state'
import { prospectDirectoryReturnHref } from './prospect-source-display'

describe('Chicago directory continuity', () => {
  it('round trips multiple sorts and page without losing unknown routing results', () => {
    const state = readChicagoDirectoryState(
      new URLSearchParams(
        'query=Arts&geography=chicago-proper&page=3&contactability=missing&sorts=productFit:desc,attainability:desc,name:asc',
      ),
    )
    expect(readChicagoDirectoryState(chicagoDirectoryParams(state, 'venue-15'))).toEqual(state)
    expect(
      prospectDirectoryReturnHref(
        '/admin/prospects',
        chicagoDirectoryParams(state, 'venue-15').toString(),
      ),
    ).toContain('venue=venue-15')
  })
  it('rejects malformed pagination and duplicate or unsupported sorting', () => {
    const state = readChicagoDirectoryState(
      new URLSearchParams('page=-9&pageSize=999&sorts=private:asc,name:asc,name:desc'),
    )
    expect(state.page).toBe(1)
    expect(state.pageSize).toBe(50)
    expect(state.sorts).toEqual([{ field: 'name', direction: 'asc' }])
    const oversized = readChicagoDirectoryState(
      new URLSearchParams(`page=100001&category=${'x'.repeat(300)}`),
    )
    expect(oversized.page).toBe(1)
    expect(oversized.category).toHaveLength(200)
  })
  it('renders only credential-free HTTP source links', () => {
    expect(chicagoSafeUrl('javascript:alert(1)')).toBeNull()
    expect(chicagoSafeUrl('https://user:secret@example.org')).toBeNull()
    expect(chicagoSafeUrl('https://example.org/evidence')).toBe('https://example.org/evidence')
  })
})
