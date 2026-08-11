import { redirect } from 'next/navigation'

/** Compatibility boundary: the client portal intentionally exposes no analytics. */
export default function AnalyticsPage(): never {
  redirect('/')
}
