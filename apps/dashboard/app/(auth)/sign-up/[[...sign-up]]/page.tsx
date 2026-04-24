import { SignUp } from '@clerk/nextjs'

export default function DashboardSignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6 py-12">
      <div className="flex flex-col items-center">
        <div className="mb-8 text-center">
          <img src="/pathfinder-logo.svg" alt="PathFinder" className="mx-auto h-8 w-auto" />
        </div>
        <SignUp />
      </div>
    </main>
  )
}
