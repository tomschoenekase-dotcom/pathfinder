import { SignIn } from '@clerk/nextjs'

import { PathFinderBrand } from '../../../../components/PathFinderBrand'

export default function DashboardSignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6 py-12">
      <div className="flex flex-col items-center">
        <div className="mb-8 text-center">
          <PathFinderBrand textClassName="text-pf-deep" />
        </div>
        <SignIn />
      </div>
    </main>
  )
}
