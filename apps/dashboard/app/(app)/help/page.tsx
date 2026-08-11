import { redirect } from 'next/navigation'

/** The simple portal consolidates help into PathFinder Support. */
export default function HelpPage() {
  redirect('/support')
}
