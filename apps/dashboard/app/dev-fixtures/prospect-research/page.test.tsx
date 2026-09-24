import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  allowed: true,
  create: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({
  redirect: mock.redirect,
  notFound: mock.notFound,
}))
vi.mock('../../../lib/local-prospect-research-boundary', () => ({
  isLocalProspectResearchRequest: () => mock.allowed,
}))
vi.mock('@pathfinder/api/prospect-research-reader', () => ({
  createLocalProspectResearchReader: mock.create,
}))
vi.mock('./reader', () => ({ LocalProspectResearchDirectory: () => null }))
import Page from './page'

describe('local research scope return', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.stubGlobal('React', React)
    vi.clearAllMocks()
    mock.allowed = true
    mock.redirect.mockImplementation(() => {
      throw new Error('redirect')
    })
    mock.notFound.mockImplementation(() => {
      throw new Error('not-found')
    })
    mock.create.mockReturnValue({ territories: async () => [] })
  })
  it('returns Chicago filters, sort, page and selected venue to the Chicago workspace', async () => {
    await expect(
      Page({
        searchParams: Promise.resolve({
          scope: 'chicago',
          geography: 'chicago-proper',
          query: '21c',
          page: '2',
          sorts: 'name:asc',
          venue: 'cv_original',
          unwanted: 'drop-me',
        }),
      }),
    ).rejects.toThrow('redirect')
    const url = new URL(mock.redirect.mock.calls[0]![0], 'http://localhost')
    expect(url.pathname).toBe('/dev-fixtures/prospect-research/chicago')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      scope: 'chicago',
      geography: 'chicago-proper',
      query: '21c',
      page: '2',
      sorts: 'name:asc',
      venue: 'cv_original',
    })
    expect(url.searchParams.has('unwanted')).toBe(false)
    expect(mock.create).not.toHaveBeenCalled()
  })
  it('checks the local boundary before redirecting', async () => {
    mock.allowed = false
    await expect(Page({ searchParams: Promise.resolve({ scope: 'chicago' }) })).rejects.toThrow(
      'not-found',
    )
    expect(mock.redirect).not.toHaveBeenCalled()
    expect(mock.create).not.toHaveBeenCalled()
  })
  it('preserves the general directory default', async () => {
    await Page({ searchParams: Promise.resolve({ scope: 'all' }) })
    expect(mock.redirect).not.toHaveBeenCalled()
    expect(mock.create).toHaveBeenCalledOnce()
  })
})
