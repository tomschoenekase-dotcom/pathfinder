import { SignIn } from '@clerk/nextjs'

import { safeEmployeeReturnPath } from '../../../lib/employee-auth-return'

type Props = {
  searchParams: Promise<{ redirect_url?: string | string[] }>
}

export default async function WebSignInPage({ searchParams }: Props) {
  const { redirect_url: redirectUrl } = await searchParams
  const returnPath = safeEmployeeReturnPath(redirectUrl)

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <SignIn forceRedirectUrl={returnPath} />
    </main>
  )
}
