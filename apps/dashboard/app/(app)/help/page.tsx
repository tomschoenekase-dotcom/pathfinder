import { redirect } from 'next/navigation'

/** The simple portal consolidates help into Torchiko Support. */
export default function HelpPage() {
  redirect('/support')
}
