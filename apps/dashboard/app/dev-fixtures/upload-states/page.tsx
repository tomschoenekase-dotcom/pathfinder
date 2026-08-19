import { notFound } from 'next/navigation'

import { UploadStateFixture, type UploadFixtureState } from './UploadStateFixture'

const STATES = ['selected', 'uploading', 'error', 'joined'] as const

export default async function UploadVisualFixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const raw = (await searchParams).state
  const candidate = Array.isArray(raw) ? raw[0] : raw
  const state: UploadFixtureState = STATES.includes(candidate as UploadFixtureState)
    ? (candidate as UploadFixtureState)
    : 'selected'
  return <UploadStateFixture state={state} />
}
