/* @vitest-environment jsdom */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { NativeContentConvergenceCard } from './NativeContentConvergenceCard'

const convergence = {
  contractVersion: 1 as const,
  phase: 'NATIVE_HEAD_IN_SYNC' as const,
  guestReadPath: 'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT' as const,
  headValid: true,
  stateMatchesHead: true,
  readyForShadowEvaluation: true,
  readyForLegacyRetirement: false as const,
  needsOperatorAttention: false,
  blockers: ['LEGACY_SEMANTIC_READ_PATH'] as const,
  counts: { activePlaces: 4, enabledKnowledgeEntries: 3, publishedGeneralizedModules: 2 },
  venueActive: true,
  head: {
    releaseId: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    updatedAt: new Date(0),
    releaseStatus: 'APPLIED',
  },
}

describe('NativeContentConvergenceCard', () => {
  it('shows in-sync evidence while retaining the legacy retirement boundary', () => {
    render(<NativeContentConvergenceCard convergence={convergence} />)
    expect(screen.getByText('Native head and materialized content match')).toBeTruthy()
    expect(screen.getByText('Shadow-ready')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText(/Guest semantic search still depends/u)).toBeTruthy()
    expect(screen.getByText(/does not switch guest retrieval/u)).toBeTruthy()
  })

  it('fails visibly when measurement is unavailable', () => {
    render(<NativeContentConvergenceCard convergence={null} />)
    expect(screen.getByRole('heading', { name: 'Content convergence unavailable' })).toBeTruthy()
    expect(screen.getByText(/No content or release state changed/u)).toBeTruthy()
  })
})
