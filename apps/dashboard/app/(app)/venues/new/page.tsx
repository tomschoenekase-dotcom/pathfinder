import { redirect } from 'next/navigation'

/** Venue creation remains available through the approved onboarding flow. */
export default function NewVenuePage() {
  redirect('/onboarding/setup')
}
