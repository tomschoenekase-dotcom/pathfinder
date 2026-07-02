import { EngagementQuestionsManager } from '../../../components/EngagementQuestionsManager'
import { createDashboardCaller } from '../../../lib/server-caller'

export default async function EngagementQuestionsPage() {
  const caller = await createDashboardCaller('/engagement-questions')
  const [{ tenant }, questions] = await Promise.all([
    caller.tenant.getSettings(),
    caller.engagementQuestion.list(),
  ])

  const serializedQuestions = questions.map((question) => ({
    ...question,
    createdAt: question.createdAt.toISOString(),
    updatedAt: question.updatedAt.toISOString(),
  }))

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-5xl space-y-8">
        <section className="rounded-[2rem] bg-pf-deep px-8 py-10 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-light">
            Engagement Questions
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">Ask guests what matters</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-light/70">
            Choose how curious your AI guide should be, then write the questions you want it to
            weave naturally into the right moments of a conversation.
          </p>
        </section>

        <EngagementQuestionsManager
          initialMode={tenant.engagementMode}
          initialQuestions={serializedQuestions}
        />
      </div>
    </main>
  )
}
