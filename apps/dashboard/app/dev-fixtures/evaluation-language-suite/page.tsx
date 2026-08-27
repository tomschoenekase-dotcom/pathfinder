import { notFound } from 'next/navigation'

import { EvaluationRunRequestPanel } from '../../../components/admin/EvaluationRunRequestPanel'
import { OnboardingEvaluationSuitePanel } from '../../../components/admin/OnboardingEvaluationSuitePanel'
import { TRPCProvider } from '../../../lib/trpc'

const payloadHash = 'a'.repeat(64)
const baseDigest = 'b'.repeat(64)
const sourceRef = `venue-package-review:fixture-package:${payloadHash}:${baseDigest}`
const languages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar'] as const
const reviewablePackages = [
  {
    id: 'fixture-package',
    status: 'DRAFT' as const,
    payloadHash,
    baseDigest,
    createdAt: new Date('2026-08-27T12:00:00.000Z'),
    approvedAt: null,
    supportHandoffs: [],
  },
]
const evaluationCases = languages.flatMap((language, languageIndex) =>
  ['grounded', 'fallback'].map((kind, kindIndex) => ({
    id: `00000000-0000-4000-8000-${(languageIndex * 2 + kindIndex).toString().padStart(12, '0')}`,
    caseKey: `onboarding-language-${language}-${kind}`,
    revision: 1,
    category: kind === 'grounded' ? 'known-answer' : 'unknown-answer',
    schemaVersion: 'v1',
    sourceType: 'ONBOARDING_REVIEWABLE_PACKAGE',
    sourceRef,
    createdAt: new Date('2026-08-27T12:00:00.000Z'),
  })),
)

export default function EvaluationLanguageSuiteVisualFixture() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <div
      data-fixture="evaluation-language-suite"
      className="min-h-screen bg-pf-cream px-4 py-6 sm:px-6"
    >
      <TRPCProvider scopeKey="fixture:evaluation-language-suite">
        <main className="mx-auto max-w-5xl space-y-5">
          <header>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
              Exact-package evaluation
            </p>
            <h1 className="mt-1 text-3xl font-semibold text-pf-deep">Launch-language QA</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/70">
              Prepare and select bounded evidence without running a provider or changing visitor
              content.
            </p>
          </header>
          <h2 className="sr-only">Evaluation controls</h2>
          <OnboardingEvaluationSuitePanel
            tenantId="fixture-tenant"
            venueId="fixture-venue"
            reviewablePackages={reviewablePackages}
          />
          <EvaluationRunRequestPanel
            tenantId="fixture-tenant"
            venueId="fixture-venue"
            initialCases={evaluationCases}
            initialNextCursor={null}
            runnerEnabled
            maximumCases={50}
            reviewablePackages={reviewablePackages}
          />
        </main>
      </TRPCProvider>
    </div>
  )
}
