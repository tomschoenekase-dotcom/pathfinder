import { notFound } from 'next/navigation'

import { AppHostSimulator } from './AppHostSimulator'

/** Development-only partner-app simulator around the real app-door guide fixture. */
export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <AppHostSimulator />
}
