import { SignUp } from '@clerk/nextjs'

import { TorchicoBrand } from '@pathfinder/ui'

export default function DashboardSignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6 py-12">
      <div className="flex flex-col items-center">
        <div className="mb-8 text-center">
          <TorchicoBrand
            gapClassName="gap-2"
            textClassName="text-pf-deep"
            textSizeClassName="text-base"
          />
        </div>
        <SignUp />
      </div>
    </main>
  )
}
