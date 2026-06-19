import { SignIn } from '@clerk/nextjs'

import { PathFinderBrand } from '@pathfinder/ui'

export default function DashboardSignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6 py-12">
      <div className="flex flex-col items-center">
        <div className="mb-8 text-center">
          <PathFinderBrand
            gapClassName="gap-2"
            textClassName="text-pf-deep"
            textSizeClassName="text-base"
          />
        </div>
        <SignIn />
      </div>
    </main>
  )
}
