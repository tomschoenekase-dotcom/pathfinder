import { OrganizationList } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

import { safeEmployeeReturnPath } from '../../lib/employee-auth-return'

type Props = {
  searchParams: Promise<{ redirect_url?: string | string[] }>
}

export default async function SelectEmployeeOrganizationPage({ searchParams }: Props) {
  const { userId } = await auth()
  const { redirect_url: redirectUrl } = await searchParams
  const returnPath = safeEmployeeReturnPath(redirectUrl)

  if (!userId) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(returnPath)}`)
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <section className="w-full max-w-xl rounded-3xl bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-500">Torchico employee access</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Choose your organization</h1>
        <p className="mb-6 mt-2 text-sm leading-6 text-slate-600">
          Select the organization that owns this private chatbot.
        </p>
        <OrganizationList
          hidePersonal
          afterSelectOrganizationUrl={returnPath}
          afterCreateOrganizationUrl={returnPath}
        />
      </section>
    </main>
  )
}
