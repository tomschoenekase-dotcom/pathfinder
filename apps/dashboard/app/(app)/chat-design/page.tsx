import { ChatDesignForm } from '../../../components/ChatDesignForm'
import { createDashboardCaller } from '../../../lib/server-caller'

export default async function ChatDesignPage() {
  const caller = await createDashboardCaller('/chat-design')

  const venues = await caller.venue.list()

  return (
    <div className="px-6 py-10">
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Chatbot Design</h1>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            Customise the colours and typeface used by each venue&apos;s guest chat.
          </p>
        </div>
        <ChatDesignForm venues={venues} />
      </div>
    </div>
  )
}
